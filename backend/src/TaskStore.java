import java.io.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Single-process, bounded durable task state. All transitions share one monitor. */
final class TaskStore {
    static final Set<String> TERMINAL=Set.of("completed","error","cancelled","interrupted");
    final Config config;
    private final LinkedHashMap<String,Task> tasks=new LinkedHashMap<>();
    private final Path dir;
    private String persistenceError="";
    TaskStore(Config config) throws IOException {
        this.config=config;dir=config.data.resolve("tasks");Files.createDirectories(dir);
        try(var files=Files.list(dir)){
            for(Path f:files.filter(p->p.toString().endsWith(".json")).sorted().toList()){
                try{
                    if(Files.size(f)>20_000_000)throw new IOException("oversized task file");
                    Task t=new Task(Json.object(Files.readString(f,StandardCharsets.UTF_8)));
                    if(!t.id.matches("[a-zA-Z0-9_-]{8,80}"))throw new IOException("invalid task id");
                    if(!t.terminal()&&!t.provider.equals("browser")&&!t.state.equals("queued")){
                        t.state="interrupted";t.detail="后端重启，未自动重复调用上游。可手动重新发送。";t.version++;
                    }
                    tasks.put(t.id,t);
                }catch(Exception e){
                    System.err.println("[WARN] Quarantining unreadable task: "+f.getFileName());
                    Files.move(f,f.resolveSibling(f.getFileName()+".corrupt-"+System.currentTimeMillis()));
                    persistenceError="发现损坏记录，已保留为 .corrupt 文件；请检查磁盘。";
                }
            }
        }
        var ordered=tasks.values().stream().sorted(Comparator.comparingLong(t->t.created)).toList();tasks.clear();
        for(Task t:ordered){tasks.put(t.id,t);persist(t);}
        prune();
    }
    static final class Task {
        final String id, requestId, message, model, provider, accountId, conversationId;
        final List<Map<String,Object>> attachments;
        final long created;
        String state="queued", text="", detail="已排队", owner="", lease="";
        List<Map<String,Object>> images=new ArrayList<>();
        long version=1, updated, started, deadline, lastSeq, leaseUntil, lastSaved;
        boolean submitted=false;
        Map<String,Object> checkpoint=new LinkedHashMap<>();
        volatile Thread runner;
        Task(String requestId,String message,String model,String provider,String accountId,String conversationId,List<Map<String,Object>> attachments){
            this.accountId=accountId;this.conversationId=conversationId;
            this.id=UUID.randomUUID().toString();this.requestId=requestId;this.message=message;this.model=model;this.provider=provider;
            this.attachments=attachments.stream().map(v->(Map<String,Object>)new LinkedHashMap<>(v)).toList();
            this.created=this.updated=System.currentTimeMillis();
        }
        @SuppressWarnings("unchecked") Task(Map<String,Object> m){
            accountId=Json.str(m,"accountId","legacy-archive");conversationId=Json.str(m,"conversationId","legacy-"+Json.str(m,"id",""));
            id=Json.str(m,"id","");requestId=Json.str(m,"requestId",id);message=Json.str(m,"message","");model=Json.str(m,"model","");provider=Json.str(m,"provider","browser");
            attachments=m.get("attachments") instanceof List<?> list?list.stream().filter(Map.class::isInstance).map(v->(Map<String,Object>)new LinkedHashMap<>((Map<String,Object>)v)).toList():List.of();
            if(m.get("images") instanceof List<?> list)images=list.stream().filter(Map.class::isInstance).map(v->(Map<String,Object>)new LinkedHashMap<>((Map<String,Object>)v)).toList();
            created=Json.num(m,"created",System.currentTimeMillis());updated=Json.num(m,"updated",created);started=Json.num(m,"started",0);deadline=Json.num(m,"deadline",0);
            state=Json.str(m,"state","error");text=Json.str(m,"text","");detail=Json.str(m,"detail","");version=Json.num(m,"version",1);
            owner=Json.str(m,"owner","");lease=Json.str(m,"lease","");lastSeq=Json.num(m,"lastSeq",0);leaseUntil=Json.num(m,"leaseUntil",0);submitted=Json.bool(m,"submitted",false);
            if(m.get("checkpoint") instanceof Map<?,?> c)checkpoint=new LinkedHashMap<>((Map<String,Object>)c);
            if(accountId.equals("legacy-archive")&&!terminal()){state="interrupted";detail="旧版记录已只读归档；不自动续跑到任何新账号";version++;}
        }
        boolean terminal(){return TERMINAL.contains(state);}
        Map<String,Object> view(){return Json.map("id",id,"accountId",accountId,"conversationId",conversationId,"requestId",requestId,"message",message,"model",model,"attachments",attachments,"images",images,"provider",provider,"created",created,"updated",updated,"started",started,"deadline",deadline,"state",state,"text",text,"detail",detail,"version",version,"submitted",submitted);}
        Map<String,Object> disk(){var m=view();m.putAll(Json.map("owner",owner,"lease",lease,"leaseUntil",leaseUntil,"lastSeq",lastSeq,"checkpoint",checkpoint));return m;}
        Map<String,Object> delivery(){var m=view();m.putAll(Json.map("lease",lease,"lastSeq",lastSeq,"checkpoint",new LinkedHashMap<>(checkpoint)));return m;}
    }
    synchronized Task create(String requestId,String message,String accountId,String conversationId){try{return create(requestId,message,accountId,conversationId,List.of(),"");}catch(IOException e){throw new UncheckedIOException(e);}}
    synchronized Task create(String requestId,String message,String accountId,String conversationId,List<Map<String,Object>> attachments,String model) throws IOException {
        for(Task t:tasks.values())if(t.accountId.equals(accountId)&&t.conversationId.equals(conversationId)&&t.requestId.equals(requestId)){
            if(!t.message.equals(message)||!t.attachments.equals(attachments)||!t.model.equals(model))throw new Conflict("同一 requestId 不能对应不同消息、图片或模型");return t;
        }
        if(tasks.values().stream().anyMatch(t->t.conversationId.equals(conversationId)&&!t.terminal()))throw new Conflict("该会话已有未结束任务；另一网页正在生成，请等待完成或停止后再发送");
        if(tasks.values().stream().filter(t->t.accountId.equals(accountId)&&!t.terminal()).count()>=config.queueMax)throw new Conflict("任务队列已满，请先等待或取消任务");
        Task t=new Task(requestId,message,model,config.provider,accountId,conversationId,attachments);persist(t);tasks.put(t.id,t);prune();notifyAll();return t;
    }
    synchronized Task task(String id){Task t=tasks.get(id);if(t==null)throw new Missing("任务不存在");return t;}
    synchronized Map<String,Object> view(String id){return task(id).view();}
    synchronized List<Map<String,Object>> list(String accountId,String conversationId,boolean full){
        var out=new ArrayList<Map<String,Object>>();
        for(Task t:tasks.values()){
            if(accountId!=null&&!accountId.equals(t.accountId)||conversationId!=null&&!conversationId.equals(t.conversationId))continue;
            var m=t.view();if(!full){m.remove("text");m.put("message",t.message.substring(0,Math.min(100,t.message.length())));m.put("attachments",t.attachments.stream().map(a->Json.map("name",Json.str(a,"name","图片"),"mimeType",Json.str(a,"mimeType",""))).toList());m.put("images",t.images.stream().map(a->Json.map("name",Json.str(a,"name","生成图片"),"mimeType",Json.str(a,"mimeType",""))).toList());}out.add(m);
        }Collections.reverse(out);return out;
    }
    synchronized List<Task> all(){return new ArrayList<>(tasks.values());}
    synchronized Map<String,Object> await(String id,long version,long ms) throws InterruptedException {
        Task t=task(id);if(t.version<=version&&!t.terminal())wait(ms);return task(id).view();
    }
    synchronized Map<String,Object> claim(String accountId,String conversationId,String clientId,int waitSeconds) throws InterruptedException,IOException {
        long until=System.currentTimeMillis()+waitSeconds*1000L;
        while(true){
            long now=System.currentTimeMillis();Task t=tasks.values().stream().filter(x->x.accountId.equals(accountId)&&x.conversationId.equals(conversationId)&&x.provider.equals("browser")&&!x.terminal()).findFirst().orElse(null);
            if(t!=null&&(t.owner.isEmpty()||t.owner.equals(clientId))&&(t.started>0||tasks.values().stream().filter(x->x.accountId.equals(accountId)&&x.started>0&&!x.terminal()).count()<config.concurrent)){
                boolean changed=!t.owner.equals(clientId)||t.lease.isEmpty();
                if(changed){t.owner=clientId;t.lease=UUID.randomUUID().toString();t.lastSeq=0;t.checkpoint=new LinkedHashMap<>();}
                t.leaseUntil=now+60_000;
                if(t.started==0){t.started=now;t.deadline=now+config.timeoutSeconds*1000L;t.state="running";t.detail="等待 ChatGPT 页面提交";changed=true;}
                if(changed)changed(t,true);
                return t.delivery();
            }
            long remaining=until-now;if(remaining<=0)return null;wait(Math.min(remaining,2000));
        }
    }
    synchronized void validateEvent(Map<String,Object> e){
        Task t=task(Json.str(e,"id",""));String lease=Json.str(e,"lease","");long seq=Json.num(e,"seq",0);
        if(lease.isEmpty()||!lease.equals(t.lease))throw new Conflict("租约不匹配");
        if(t.terminal()||seq<=t.lastSeq)return;
        if(seq!=t.lastSeq+1)throw new Conflict("事件序号不连续");
        if(!Set.of("submitting","snapshot","progress","done","error","interrupted","checkpoint").contains(Json.str(e,"type","")))throw new IllegalArgumentException("未知事件类型");
        if(Json.str(e,"text",t.text).length()>1_000_000)throw new IllegalArgumentException("回答超过 100 万字符限制");
        if(e.get("checkpoint") instanceof Map<?,?> cp&&Json.stringify(cp).length()>100_000)throw new IllegalArgumentException("检查点过大");
    }
    @SuppressWarnings("unchecked") synchronized Map<String,Object> event(Map<String,Object> e) throws IOException {
        Task t=task(Json.str(e,"id",""));String lease=Json.str(e,"lease","");long seq=Json.num(e,"seq",0);
        if(!t.lease.equals(lease)||lease.isEmpty())throw new Conflict("任务租约已变化，禁止旧页面继续回传");
        if(t.terminal()){persist(t);return Json.map("ok",true,"terminal",true,"state",t.state,"lastSeq",t.lastSeq);}
        if(seq<=t.lastSeq){persist(t);return Json.map("ok",true,"duplicate",true,"lastSeq",t.lastSeq,"state",t.state);}
        if(seq!=t.lastSeq+1)throw new Conflict("事件序号不连续，请重新读取任务状态");
        String type=Json.str(e,"type","");
        if(!Set.of("submitting","snapshot","progress","done","error","interrupted","checkpoint").contains(type))throw new IllegalArgumentException("未知事件类型");
        String text=Json.str(e,"text",t.text);if(text.length()>1_000_000)throw new IllegalArgumentException("回答超过 100 万字符限制");
        if(e.get("checkpoint") instanceof Map<?,?> c){
            if(Json.stringify(c).length()>100_000)throw new IllegalArgumentException("检查点过大");
            t.checkpoint=new LinkedHashMap<>((Map<String,Object>)c);
        }
        if(type.equals("submitting")) {t.submitted=true;t.detail="已准备提交；恢复时不会盲目重发";}
        if(type.equals("snapshot")||type.equals("done"))t.text=text;
        if((type.equals("snapshot")||type.equals("done"))&&e.get("images") instanceof List<?> list)t.images=list.stream().filter(Map.class::isInstance).map(v->(Map<String,Object>)new LinkedHashMap<>((Map<String,Object>)v)).toList();
        if(type.equals("snapshot"))t.detail="正在接收网页回复";
        if(type.equals("progress"))t.detail=Json.str(e,"detail","等待页面回复");
        if(type.equals("done")){t.state="completed";t.detail="已完成";}
        if(type.equals("error")||type.equals("interrupted")){t.state=type;t.detail=Json.str(e,"detail","页面任务中断");}
        t.lastSeq=seq;t.leaseUntil=System.currentTimeMillis()+60_000;
        // Every browser ACK is durable: retry after worker/backend restart is idempotent.
        changed(t,true);return Json.map("ok",true,"lastSeq",t.lastSeq,"state",t.state,"terminal",t.terminal());
    }
    synchronized void begin(Task t) throws IOException {
        if(t.terminal()||!t.state.equals("queued"))return;
        t.state="running";t.started=System.currentTimeMillis();t.deadline=t.started+config.timeoutSeconds*1000L;t.detail="正在连接上游";changed(t,true);
    }
    synchronized boolean live(Task t){return !t.terminal();}
    synchronized void output(Task t,String text,String detail) throws IOException {
        if(t.terminal())return;if(text.length()>1_000_000)throw new IOException("回答超过 100 万字符限制");
        boolean firstOutput=t.text.isEmpty()&&!text.isEmpty();
        t.text=text;t.detail=detail;changed(t,firstOutput);
    }
    synchronized void finish(Task t,String state,String detail) throws IOException {
        if(t.terminal())return;t.state=state;t.detail=detail;changed(t,true);
    }
    synchronized void cancel(String id) throws IOException {
        Task t=task(id);finish(t,"cancelled","已取消；网页停止操作为尽力而为，必要时请在 ChatGPT 页面手动停止");
        if(t.runner!=null)t.runner.interrupt();
    }
    synchronized void delete(String id) throws IOException {
        Task t=task(id);if(!t.terminal())throw new Conflict("运行中的任务不能删除，请先取消");
        Files.deleteIfExists(dir.resolve(t.id+".json"));tasks.remove(id);notifyAll();
    }
    synchronized int clearHistory(String accountId) throws IOException {
        int n=0;for(Task t:new ArrayList<>(tasks.values()))if(t.terminal()&&(accountId==null||accountId.equals(t.accountId))){delete(t.id);n++;}return n;
    }
    synchronized void sweep() throws IOException {
        long now=System.currentTimeMillis();
        for(Task t:tasks.values()){
            if(!t.terminal()&&((t.deadline>0&&now>t.deadline)||(t.started==0&&now-t.created>config.timeoutSeconds*1000L))){
                finish(t,"interrupted","任务等待超时；已保存部分回答，未自动重新提交。请检查后端、绑定页面和登录状态。");if(t.runner!=null)t.runner.interrupt();
            }else if(!t.terminal()&&now-t.lastSaved>1000&&t.updated>t.lastSaved)persist(t);
        }
    }
    synchronized void flush() {for(Task t:tasks.values())try{persist(t);}catch(IOException e){System.err.println("[ERROR] Failed to persist task "+t.id);}}
    synchronized String persistenceError(){return persistenceError;}
    private void changed(Task t,boolean force) throws IOException {
        t.updated=System.currentTimeMillis();t.version++;
        if(force||t.updated-t.lastSaved>1000)persist(t);
        notifyAll();
    }
    private void persist(Task t) throws IOException {
        Path target=dir.resolve(t.id+".json"),tmp=dir.resolve(t.id+".tmp");
        try{
            byte[] bytes=Json.stringify(t.disk()).getBytes(StandardCharsets.UTF_8);
            try(FileChannel ch=FileChannel.open(tmp,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE)){
                ByteBuffer b=ByteBuffer.wrap(bytes);while(b.hasRemaining())ch.write(b);ch.force(true);
            }
            try{Files.move(tmp,target,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}
            catch(AtomicMoveNotSupportedException e){Files.move(tmp,target,StandardCopyOption.REPLACE_EXISTING);}
            t.lastSaved=System.currentTimeMillis();
        }catch(IOException e){persistenceError="任务持久化失败，请检查磁盘空间与 data 目录权限";throw e;}
    }
    private void prune() throws IOException {
        // Never prune across accounts, and never delete the legacy archive automatically.
        Map<String,Integer> sizes=new HashMap<>();
        for(Task t:tasks.values())sizes.merge(t.accountId,1,Integer::sum);
        for(Task t:new ArrayList<>(tasks.values()))if(!t.accountId.equals("legacy-archive")&&sizes.get(t.accountId)>config.historyMax&&t.terminal()){
            delete(t.id);sizes.merge(t.accountId,-1,Integer::sum);
        }
    }
    synchronized boolean hasLive(String accountId,String conversationId){return tasks.values().stream().anyMatch(t->!t.terminal()&&(accountId==null||accountId.equals(t.accountId))&&(conversationId==null||conversationId.equals(t.conversationId)));}
    synchronized void deleteConversation(String conversationId)throws IOException{
        if(hasLive(null,conversationId))throw new Conflict("运行中的会话不能删除，请先停止所有任务");
        for(Task t:new ArrayList<>(tasks.values()))if(t.conversationId.equals(conversationId))delete(t.id);
    }
    synchronized List<Map<String,Object>> context(Task current){
        List<Map<String,Object>> input=new ArrayList<>();
        for(Task t:tasks.values())if(t.accountId.equals(current.accountId)&&t.conversationId.equals(current.conversationId)){
            if(t.id.equals(current.id))break;
            if(t.state.equals("completed")){input.add(Json.map("role","user","content",t.message));input.add(Json.map("role","assistant","content",t.text));}
        }
        // Explicit bounded context; the browser provider uses its own bound thread instead.
        if(input.size()>40)input=new ArrayList<>(input.subList(input.size()-40,input.size()));
        input.add(Json.map("role","user","content",current.message));return input;
    }
    static class Conflict extends RuntimeException{Conflict(String m){super(m);}}
    static class Missing extends RuntimeException{Missing(String m){super(m);}}
}
