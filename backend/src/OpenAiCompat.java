import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Small account-scoped OpenAI Chat Completions facade for local agent clients. */
final class OpenAiCompat {
    private static final int MAX_PROMPT_CHARS=500_000;
    private static final int WEB_PROMPT_CHARS=20_000;
    private static final LinkedHashMap<String,String> MODELS=new LinkedHashMap<>();
    static {
        MODELS.put("gbt","");
        MODELS.put("gbt-6-instant","gpt-5-6");
        MODELS.put("gbt-6-thinking","gpt-5-6-thinking-standard");
        MODELS.put("gbt-6-high","gpt-5-6-thinking-extended");
        MODELS.put("gbt-6-max","gpt-5-6-thinking-max");
        MODELS.put("gbt-6-pro","gpt-6-pro");
    }
    private OpenAiCompat() {}

    static void handle(BackendServer app,HttpExchange x,String method,String path,WorkspaceStore.Principal principal)throws Exception {
        WorkspaceStore.requireAccount(principal);
        if(path.equals("/v1/models")){
            BackendServer.require(method,"GET");
            BackendServer.send(x,200,Json.map("object","list","data",MODELS.keySet().stream().map(OpenAiCompat::modelView).toList()));return;
        }
        if(path.startsWith("/v1/models/")){
            BackendServer.require(method,"GET");String id=path.substring(11);
            if(!MODELS.containsKey(id))throw new TaskStore.Missing("模型不存在");BackendServer.send(x,200,modelView(id));return;
        }
        if(!path.equals("/v1/chat/completions"))throw new TaskStore.Missing("OpenAI 兼容接口不存在");
        BackendServer.require(method,"POST");
        Map<String,Object> request=BackendServer.body(x);String model=Json.str(request,"model","gbt");
        if(!MODELS.containsKey(model))throw new IllegalArgumentException("不支持的模型；请先 GET /v1/models");
        if(app.config.provider.equals("browser")&&app.visibleBridges(principal.accountId(),75_000).stream().noneMatch(b->Json.bool(b,"ready",false)))
            throw new TaskStore.Conflict("GBT 浏览器桥接未就绪；请保持对应账号的 Edge 工作窗口和扩展在线");
        Prompt prompt=prompt(request);boolean stream=Json.bool(request,"stream",false);String conversationId="api-"+UUID.randomUUID(),requestId=UUID.randomUUID().toString();
        TaskStore.Task task;
        synchronized(app.workspaceLock){
            app.workspaces.createConversation(principal.accountId(),conversationId,"API · "+shortTitle(prompt.text()));
            task=app.store.create(requestId,prompt.text(),principal.accountId(),conversationId,List.of(),MODELS.get(model));app.upstream.submit(task);
        }
        try{
            if(stream)stream(app,x,task,model,prompt.toolNames());
            else complete(app,x,task,model,prompt.toolNames(),prompt.inputChars());
        }finally{
            if(task.terminal())try{synchronized(app.workspaceLock){app.store.deleteConversation(conversationId);app.workspaces.delete(conversationId);}}catch(Exception ignored){}
        }
    }

    private static Map<String,Object> modelView(String id){return Json.map("id",id,"object","model","created",0,"owned_by","gbt-local");}
    private record Prompt(String text,Set<String> toolNames,int inputChars) {}
    @SuppressWarnings("unchecked") private static Prompt prompt(Map<String,Object> request){
        Object raw=request.get("messages");if(!(raw instanceof List<?> messages)||messages.isEmpty())throw new IllegalArgumentException("messages 必须是非空数组");
        StringBuilder out=new StringBuilder("你正在通过 GBT 的 OpenAI 兼容接口回答。请遵循下面按角色标记的完整对话。\n\n");int input=0;String latestUser="";
        for(Object item:messages){
            if(!(item instanceof Map<?,?> source))throw new IllegalArgumentException("messages 项格式无效");Map<String,Object> m=(Map<String,Object>)source;
            String role=Json.str(m,"role","");if(!Set.of("system","developer","user","assistant","tool").contains(role))throw new IllegalArgumentException("不支持的消息角色："+role);
            String text=content(m.get("content"));if(role.equals("user")&&!isInternalRuntimeContext(text))latestUser=text;input+=text.length();out.append('[').append(role.toUpperCase(Locale.ROOT)).append(']');
            String call=Json.str(m,"tool_call_id","");if(!call.isEmpty())out.append(" tool_call_id=").append(call);out.append('\n').append(text).append("\n\n");
            if(m.get("tool_calls") instanceof List<?> calls&&!calls.isEmpty())out.append("[ASSISTANT_TOOL_CALLS]\n").append(Json.stringify(calls)).append("\n\n");
        }
        String explicit=Json.str(request,"prompt","");
        if(explicit.isEmpty()&&request.get("input") instanceof String value)explicit=value;
        if(!explicit.isEmpty()&&!explicit.equals(latestUser)){latestUser=explicit;input+=explicit.length();out.append("[USER]\n").append(explicit).append("\n\n");}
        Set<String> names=new LinkedHashSet<>();Object toolsRaw=request.get("tools");
        if(toolsRaw instanceof List<?> tools&&!tools.isEmpty()){
            if(tools.size()>128)throw new IllegalArgumentException("tools 数量超过限制");
            for(Object item:tools)if(item instanceof Map<?,?> tool&&tool.get("function") instanceof Map<?,?> fn){Object name=fn.get("name");if(name instanceof String s&&s.matches("[A-Za-z0-9_-]{1,64}"))names.add(s);}
            out.append("[AVAILABLE_TOOLS]\n").append(Json.stringify(tools)).append("\n\n")
               .append("如需调用工具，只输出严格 JSON，不要加 Markdown：{\"tool_calls\":[{\"name\":\"工具名\",\"arguments\":{}}]}。")
               .append("工具名必须来自 AVAILABLE_TOOLS；不需要工具时正常回答文本。\n");
        }
        if(out.length()>MAX_PROMPT_CHARS)throw new IllegalArgumentException("输入超过 GBT 网页桥接的 500000 字符限制");
        String text=out.toString();
        if(text.length()>WEB_PROMPT_CHARS){
            if(!latestUser.isEmpty())text+="\n\n[LATEST_USER_REQUEST]\n"+latestUser+"\n";
            int side=(WEB_PROMPT_CHARS-160)/2;
            text=text.substring(0,side)+"\n\n[GBT 已压缩中间历史内容以适配 ChatGPT 网页输入长度；保留了开头规则以及末尾的最新消息和工具定义]\n\n"+text.substring(text.length()-side);
        }
        return new Prompt(text,names,input);
    }
    private static boolean isInternalRuntimeContext(String text){
        String value=text.trim();
        return value.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")&&value.endsWith("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>");
    }
    @SuppressWarnings("unchecked") private static String content(Object raw){
        if(raw==null)return "";if(raw instanceof String s)return s;if(!(raw instanceof List<?> parts))throw new IllegalArgumentException("message content 格式无效");
        StringBuilder out=new StringBuilder();for(Object part:parts){if(!(part instanceof Map<?,?> p))throw new IllegalArgumentException("content part 格式无效");Object typeRaw=p.get("type");String type=typeRaw==null?"":String.valueOf(typeRaw);
            if(type.equals("text")||type.equals("input_text")){Object text=p.get("text");if(text instanceof String s)out.append(s);else throw new IllegalArgumentException("文本 content part 缺少 text");}
            else throw new IllegalArgumentException("GBT OpenAI 接口当前仅支持文本 content part");}
        return out.toString();
    }
    private static String shortTitle(String text){String clean=text.replaceAll("\\s+"," ").trim();return clean.substring(0,Math.min(70,clean.length()));}

    private static Map<String,Object> await(BackendServer app,TaskStore.Task task)throws InterruptedException {
        Map<String,Object> view=task.view();long deadline=System.currentTimeMillis()+app.config.timeoutSeconds*1000L+30_000;
        while(!TaskStore.TERMINAL.contains(Json.str(view,"state",""))&&System.currentTimeMillis()<deadline)view=app.store.await(task.id,Json.num(view,"version",0),Math.min(1000,Math.max(1,deadline-System.currentTimeMillis())));
        if(!TaskStore.TERMINAL.contains(Json.str(view,"state",""))){try{app.store.cancel(task.id);}catch(IOException ignored){}throw new TaskStore.Conflict("GBT 调用等待超时");}return view;
    }
    private record Answer(String content,List<Map<String,Object>> toolCalls,String finish) {}
    @SuppressWarnings("unchecked") private static Answer answer(String text,Set<String> allowed){
        if(allowed.isEmpty())return new Answer(text,List.of(),"stop");String candidate=text.trim();
        if(candidate.startsWith("```")){candidate=candidate.replaceFirst("^```(?:json)?\\s*","").replaceFirst("\\s*```$","").trim();}
        try{
            Object parsed=Json.parse(candidate);if(!(parsed instanceof Map<?,?> root)||!(root.get("tool_calls") instanceof List<?> calls)||calls.isEmpty())return new Answer(text,List.of(),"stop");
            var result=new ArrayList<Map<String,Object>>();for(Object raw:calls){if(!(raw instanceof Map<?,?> call))return new Answer(text,List.of(),"stop");Object name=call.get("name"),arguments=call.get("arguments");
                if(!(name instanceof String n)||!allowed.contains(n))return new Answer(text,List.of(),"stop");String args=arguments instanceof String s?s:Json.stringify(arguments==null?Map.of():arguments);
                result.add(Json.map("id","call_"+UUID.randomUUID().toString().replace("-",""),"type","function","function",Json.map("name",n,"arguments",args)));}
            return new Answer(null,result,"tool_calls");
        }catch(Exception ignored){return new Answer(text,List.of(),"stop");}
    }
    private static Map<String,Object> message(Answer answer){var m=Json.map("role","assistant","content",answer.content());if(!answer.toolCalls().isEmpty())m.put("tool_calls",answer.toolCalls());return m;}
    private static void requireSuccess(Map<String,Object> task){String state=Json.str(task,"state","");if(!state.equals("completed"))throw new TaskStore.Conflict("GBT 生成未完成："+Json.str(task,"detail",state));}
    private static void complete(BackendServer app,HttpExchange x,TaskStore.Task task,String model,Set<String> tools,int inputChars)throws Exception {
        Map<String,Object> view=await(app,task);requireSuccess(view);String text=Json.str(view,"text","");Answer answer=answer(text,tools);long created=System.currentTimeMillis()/1000;
        BackendServer.send(x,200,Json.map("id","chatcmpl-"+task.id,"object","chat.completion","created",created,"model",model,"choices",List.of(Json.map("index",0,"message",message(answer),"finish_reason",answer.finish())),"usage",Json.map("prompt_tokens",Math.max(1,inputChars/4),"completion_tokens",Math.max(1,text.length()/4),"total_tokens",Math.max(2,(inputChars+text.length())/4))));
    }
    private static void stream(BackendServer app,HttpExchange x,TaskStore.Task task,String model,Set<String> tools)throws Exception {
        x.getResponseHeaders().set("Content-Type","text/event-stream; charset=utf-8");x.getResponseHeaders().set("Connection","keep-alive");x.sendResponseHeaders(200,0);OutputStream out=x.getResponseBody();long created=System.currentTimeMillis()/1000;String id="chatcmpl-"+task.id;
        event(out,Json.map("id",id,"object","chat.completion.chunk","created",created,"model",model,"choices",List.of(Json.map("index",0,"delta",Json.map("role","assistant"),"finish_reason",null))));
        Map<String,Object> view=task.view();long deadline=System.currentTimeMillis()+app.config.timeoutSeconds*1000L+30_000,nextPing=System.currentTimeMillis()+5000;
        while(!TaskStore.TERMINAL.contains(Json.str(view,"state",""))&&System.currentTimeMillis()<deadline){view=app.store.await(task.id,Json.num(view,"version",0),1000);if(System.currentTimeMillis()>=nextPing){out.write(": keep-alive\n\n".getBytes(StandardCharsets.UTF_8));out.flush();nextPing=System.currentTimeMillis()+5000;}}
        if(!TaskStore.TERMINAL.contains(Json.str(view,"state","")))try{app.store.cancel(task.id);}catch(IOException ignored){}
        if(!Json.str(view,"state","").equals("completed")){event(out,Json.map("error",Json.map("message","GBT 生成未完成："+Json.str(view,"detail",Json.str(view,"state","error")),"type","gbt_bridge_error")));out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));out.flush();return;}
        Answer answer=answer(Json.str(view,"text",""),tools);Map<String,Object> delta=answer.toolCalls().isEmpty()?Json.map("content",answer.content()):Json.map("tool_calls",answer.toolCalls());
        event(out,Json.map("id",id,"object","chat.completion.chunk","created",created,"model",model,"choices",List.of(Json.map("index",0,"delta",delta,"finish_reason",null))));
        event(out,Json.map("id",id,"object","chat.completion.chunk","created",created,"model",model,"choices",List.of(Json.map("index",0,"delta",Map.of(),"finish_reason",answer.finish()))));out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));out.flush();
    }
    private static void event(OutputStream out,Object value)throws IOException {out.write(("data: "+Json.stringify(value)+"\n\n").getBytes(StandardCharsets.UTF_8));out.flush();}
}
