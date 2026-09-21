import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

final class Upstream {
    final Config config;final TaskStore store;
    final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(12)).build();
    final Semaphore slots=new Semaphore(6);
    Upstream(Config c,TaskStore s){config=c;store=s;}
    void submit(TaskStore.Task t){
        if(t.provider.equals("browser"))return;
        synchronized(t){
            if(t.runner!=null||!store.live(t))return;
            t.runner=Thread.ofVirtual().unstarted(()->run(t));t.runner.start();
        }
    }
    void run(TaskStore.Task t){
        boolean acquired=false;
        try{
            slots.acquire();acquired=true;if(!store.live(t))return;store.begin(t);
            if(t.provider.equals("mock"))mock(t);else openai(t);
        }catch(InterruptedException e){Thread.currentThread().interrupt();fail(t,"interrupted","请求已中断，未自动重发");}
        catch(Exception e){fail(t,"error",safe(e.getMessage()));}
        finally{if(acquired)slots.release();}
    }
    void fail(TaskStore.Task t,String state,String detail){try{store.finish(t,state,detail);}catch(IOException ignored){System.err.println("[ERROR] Task failure could not be saved: "+t.id);}}
    String safe(String text){String s=text==null?"上游连接失败":text;if(!config.apiKey.isEmpty())s=s.replace(config.apiKey,"[REDACTED]");return s.substring(0,Math.min(s.length(),600));}
    void mock(TaskStore.Task t)throws Exception{
        String text="这是一条本地模拟回复，不会发送到任何模型服务。\n\n你发送的是：\n"+t.message+"\n\n任务由 Java 后端独立管理。关闭网页后重新打开，仍可查看状态和已经生成的内容。";
        StringBuilder b=new StringBuilder();
        for(int cp:text.codePoints().toArray()){
            if(!store.live(t))return;b.appendCodePoint(cp);store.output(t,b.toString(),"正在生成模拟回复");Thread.sleep(16);
        }store.finish(t,"completed","模拟回复已完成");
    }
    @SuppressWarnings("unchecked") void openai(TaskStore.Task t)throws Exception{
        // API context is built from this account + conversation only (last 20 completed turns).
        String body=Json.stringify(Json.map("model",config.model,"input",store.context(t),"stream",true,"store",false));
        HttpRequest request=HttpRequest.newBuilder(URI.create(config.apiBase+"/responses"))
            .timeout(Duration.ofSeconds(config.timeoutSeconds))
            .header("Authorization","Bearer "+config.apiKey).header("Content-Type","application/json")
            .header("Accept","text/event-stream").POST(HttpRequest.BodyPublishers.ofString(body,StandardCharsets.UTF_8)).build();
        HttpResponse<InputStream> response=http.send(request,HttpResponse.BodyHandlers.ofInputStream());
        try(InputStream stream=response.body()){
            if(response.statusCode()/100!=2){
                // Do not relay raw upstream bodies: proxy errors can contain sensitive data.
                throw new IOException("上游 HTTP "+response.statusCode()+"；请核对模型权限、API Key、额度及 API 地址");
            }
            var done=new java.util.concurrent.atomic.AtomicBoolean(false);
            // BodyHandlers.ofInputStream completes on headers; enforce timeout/cancel while reading too.
            Thread watchdog=Thread.ofVirtual().start(()->{
                try{while(!done.get()){Thread.sleep(500);if(!store.live(t)||System.currentTimeMillis()>t.deadline){stream.close();return;}}}
                catch(Exception ignored){}
            });
            try(BufferedReader reader=new BufferedReader(new InputStreamReader(stream,StandardCharsets.UTF_8))){
                String line;StringBuilder data=new StringBuilder();
                Map<String,StringBuilder> parts=new LinkedHashMap<>();boolean completed=false;
                while((line=reader.readLine())!=null){
                    if(!store.live(t))return;
                    if(line.startsWith("data:")){
                        if(data.length()>2_000_000)throw new IOException("上游 SSE 事件过大");
                        if(!data.isEmpty())data.append('\n');data.append(line.substring(5).stripLeading());
                    }else if(line.isEmpty()&&!data.isEmpty()){
                        String block=data.toString();data.setLength(0);
                        if(block.equals("[DONE]"))continue;
                        Map<String,Object> event=Json.object(block);String type=Json.str(event,"type","");
                        String key=Json.str(event,"item_id",String.valueOf(Json.num(event,"output_index",0)))+":"+Json.num(event,"content_index",0);
                        if(type.equals("response.output_text.delta")||type.equals("response.refusal.delta")){
                            parts.computeIfAbsent(key,k->new StringBuilder()).append(Json.str(event,"delta",""));
                            store.output(t,join(parts),"正在接收 API 回复");
                        }else if(type.equals("response.output_text.done")||type.equals("response.refusal.done")){
                            parts.put(key,new StringBuilder(Json.str(event,type.contains("refusal")?"refusal":"text","")));
                            store.output(t,join(parts),"正在接收 API 回复");
                        }else if(type.equals("response.completed")){
                            // A provider may send a final output even without individual delta events.
                            if(event.get("response") instanceof Map<?,?> r){String finalText=outputText((Map<String,Object>)r);if(!finalText.isEmpty())store.output(t,finalText,"已完成");}
                            store.finish(t,"completed","API 回复已完成");completed=true;break;
                        }else if(Set.of("error","response.failed","response.incomplete").contains(type)){
                            throw new IOException("上游返回 "+type+"；部分回答已保留，请检查额度、输出长度或服务状态");
                        }
                    }
                }
                if(!completed&&store.live(t))throw new IOException("上游流在完成事件之前断开，已保存部分回复；不会自动重复计费请求");
            }finally{done.set(true);watchdog.interrupt();}
        }
    }
    static String join(Map<String,StringBuilder> parts){return String.join("\n\n",parts.values().stream().map(StringBuilder::toString).toList());}
    @SuppressWarnings("unchecked") static String outputText(Map<String,Object> response){
        List<String> out=new ArrayList<>();
        if(response.get("output") instanceof List<?> items)for(Object item:items){
            if(item instanceof Map<?,?> m&&m.get("content") instanceof List<?> content)for(Object part:content){
                if(part instanceof Map<?,?> p){String type=Json.str((Map<String,Object>)p,"type","");
                    if(type.equals("output_text"))out.add(Json.str((Map<String,Object>)p,"text",""));
                    else if(type.equals("refusal"))out.add(Json.str((Map<String,Object>)p,"refusal",""));
                }
            }
        }return String.join("\n\n",out);
    }
}
