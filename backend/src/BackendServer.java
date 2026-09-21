import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;

/** Java 21 local-only backend. HTTP connections observe tasks; they do not own tasks. */
public final class BackendServer {
    static final String VERSION="1.2.1";
    final Config config;final TaskStore store;final Upstream upstream;
    final WorkspaceStore workspaces;final Object workspaceLock=new Object();
    final HttpServer server;final String token;final String instanceId=UUID.randomUUID().toString();
    final long startedAt=System.currentTimeMillis();
    final FileChannel lockChannel;final FileLock lock;
    final ScheduledExecutorService maintenance=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().factory());
    final Map<String,Map<String,Object>> bridges=new ConcurrentHashMap<>();
    final Semaphore streams=new Semaphore(64), polls=new Semaphore(64), requests=new Semaphore(256);
    volatile boolean stopping;
    BackendServer()throws Exception{
        config=new Config();
        lockChannel=FileChannel.open(config.data.resolve("backend.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);
        lock=lockChannel.tryLock();if(lock==null)throw new IOException("此 data 目录的后端已经启动，请勿重复运行");
        token=loadToken(config.data.resolve("local-token.txt"));
        workspaces=new WorkspaceStore(config);store=new TaskStore(config);
        for(var task:store.all())if(!task.accountId.equals("legacy-archive")){
            if(!workspaces.accounts.containsKey(task.accountId)||!workspaces.conversations.containsKey(task.conversationId))
                throw new IOException("任务缺少账号/会话元数据。请恢复完整 data 备份，不要只复制 tasks 或删除 workspaces.json。");
            if(!task.accountId.equals(Json.str(workspaces.conversation(task.conversationId),"accountId","")))
                throw new IOException("任务与会话账号不一致，请恢复备份后再启动");
        }
        upstream=new Upstream(config,store);
        server=HttpServer.create(new InetSocketAddress("127.0.0.1",config.port),64);
        server.createContext("/",this::handle);server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
    }
    public static void main(String[] args){
        try{
            BackendServer app=new BackendServer();app.start();
            Runtime.getRuntime().addShutdownHook(new Thread(app::stop));
        }catch(Exception e){System.err.println("[STARTUP ERROR] "+e.getMessage());System.exit(1);}
    }
    void start(){
        server.start();
        maintenance.scheduleWithFixedDelay(()->{try{store.sweep();bridges.entrySet().removeIf(e->System.currentTimeMillis()-Json.num(e.getValue(),"lastSeen",0)>180_000);}catch(Exception e){System.err.println("[ERROR] Maintenance failed: "+e.getClass().getSimpleName());}},1,1,TimeUnit.SECONDS);
        for(var t:store.all())if(t.state.equals("queued"))upstream.submit(t);
        System.out.println("GBT "+VERSION+"  |  Java "+Runtime.version().feature());
        System.out.println("Listening: http://127.0.0.1:"+config.port+"  |  provider="+config.provider);
        System.out.println("Local administrator token file: "+config.data.resolve("local-token.txt"));
        System.out.println("Use local-token.txt ONLY in Account Management to create account-scoped tokens. Pair one account token per independent browser profile.");
        System.out.println("Data is saved locally in plain text. Do not share the data directory or logs containing the token.");
    }
    synchronized void stop(){
        if(stopping)return;stopping=true;maintenance.shutdownNow();
        for(var t:store.all())if(t.runner!=null)t.runner.interrupt();
        store.flush();server.stop(1);
        try{lock.release();lockChannel.close();}catch(IOException ignored){}
    }
    static String loadToken(Path path)throws Exception{
        if(Files.exists(path)){String t=Files.readString(path).trim();if(!t.matches("[A-Za-z0-9_-]{40,100}"))throw new IOException("配对令牌格式无效；停止后端后删除 data/local-token.txt 再启动");return t;}
        byte[] random=new byte[32];new SecureRandom().nextBytes(random);String t=Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        Files.writeString(path,t,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);
        try{Files.setPosixFilePermissions(path,java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));}catch(UnsupportedOperationException ignored){}
        return t;
    }
    void handle(HttpExchange x)throws IOException{
        if(!requests.tryAcquire()){send(x,503,Json.map("error","请求过多，请稍后重试"));x.close();return;}
        try{
            if(!security(x))return;
            String method=x.getRequestMethod(),path=x.getRequestURI().getPath();
            if(method.equals("OPTIONS")){x.sendResponseHeaders(204,-1);return;}
            if(path.equals("/health")){
                require(method,"GET");send(x,200,Json.map("ok",true,"app","java-stream-chat","version",VERSION,"instanceId",instanceId,"port",config.port,"provider",config.provider,"model",config.model,"multiAccount",true));return;
            }
            if(!path.startsWith("/api/")&&!path.startsWith("/admin/")&&!path.startsWith("/v1/")){require(method,"GET");staticFile(x,path);return;}
            if(path.equals("/api/bootstrap-account")){
                require(method,"POST");
                String origin=x.getRequestHeaders().getFirst("Origin"),expected="http://127.0.0.1:"+config.port;
                if(!expected.equals(origin)&&!("http://localhost:"+config.port).equals(origin))throw new WorkspaceStore.Forbidden("首次账号只能从本机 GBT 聊天页创建");
                var m=body(x);String name=Json.str(m,"name","我的账号").trim();if(name.isEmpty())name="我的账号";
                synchronized(workspaceLock){
                    if(!workspaces.accounts.isEmpty())throw new TaskStore.Conflict("已经创建过账号。请复制当前聊天页保存的账号令牌，或到账号管理中重置令牌。");
                    send(x,201,workspaces.createAccount(name));
                }return;
            }
            var principal=workspaces.authenticate(x.getRequestHeaders().getFirst("Authorization"),token);
            if(principal==null){send(x,401,Json.map("error","令牌无效。首次使用请用 data/local-token.txt 创建账号；已有账号请用该账号专属令牌。"));return;}
            String accountId=principal.admin()?null:principal.accountId();
            if(path.startsWith("/v1/")){OpenAiCompat.handle(this,x,method,path,principal);return;}
            if(path.equals("/api/me")){
                require(method,"GET");send(x,200,Json.map("role",principal.admin()?"admin":"account","account",principal.admin()?null:workspaces.accountView(accountId),"version",VERSION,"provider",config.provider,"maxConcurrent",config.concurrent));return;
            }
            if(path.equals("/api/accounts")){
                if(method.equals("GET")){send(x,200,Json.map("accounts",workspaces.accountList(principal)));return;}
                require(method,"POST");WorkspaceStore.requireAdmin(principal);var m=body(x);
                synchronized(workspaceLock){send(x,201,workspaces.createAccount(Json.str(m,"name","")));}return;
            }
            if(path.matches("/api/accounts/[A-Za-z0-9_-]+/rotate")){
                require(method,"POST");WorkspaceStore.requireAdmin(principal);body(x);String id=path.split("/")[3];
                synchronized(workspaceLock){if(store.hasLive(id,null))throw new TaskStore.Conflict("此账号仍有未结束任务，先停止任务再重置令牌和浏览器绑定");
                    send(x,200,workspaces.rotate(id));bridges.entrySet().removeIf(e->id.equals(Json.str(e.getValue(),"accountId","")));}return;
            }
            if(path.equals("/api/legacy-export")){
                require(method,"GET");WorkspaceStore.requireAdmin(principal);send(x,200,Json.map("note","旧版单任务记录；未推断所属上游账号，也未自动并入新账号","tasks",store.list("legacy-archive",null,true)));return;
            }
            if(path.equals("/api/diagnostics")){
                require(method,"GET");send(x,200,Json.map("version",VERSION,"provider",config.provider,"model",config.model,"role",principal.admin()?"admin":"account","accountId",accountId,"uptimeSeconds",(System.currentTimeMillis()-startedAt)/1000,"taskTimeoutSeconds",config.timeoutSeconds,"tasks",store.list(accountId,null,false).size(),"bridges",visibleBridges(accountId,180_000),"persistenceError",store.persistenceError(),"activeStreams",64-streams.availablePermits(),"maxConcurrent",config.concurrent,"note","账号身份由独立浏览器配置文件及人工登录确认；不读取 Cookie，不绕过上游限制"));return;
            }
            if(path.equals("/api/extension/status")){
                require(method,"GET");var live=visibleBridges(accountId,75_000);send(x,200,Json.map("open",!live.isEmpty(),"ready",live.stream().anyMatch(b->Json.bool(b,"ready",false)),"bridges",live));return;
            }
            if(path.equals("/api/bridge/register")){
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);String clientId=clientId(m);
                synchronized(workspaceLock){
                    if(Json.str(workspaces.accountView(accountId),"clientId","").isEmpty()&&!Json.bool(m,"confirmProfile",false))throw new IllegalArgumentException("请先确认此独立浏览器配置文件仅用于这个登录账号");
                    send(x,200,Json.map("ok",true,"account",workspaces.register(accountId,clientId,Json.str(m,"profileLabel","")),"maxConcurrent",config.concurrent));
                }return;
            }
            if(path.equals("/api/bridge/heartbeat")){
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);String id=clientId(m);workspaces.checkClient(accountId,id);
                bridges.put(accountId,Json.map("accountId",accountId,"clientId",id,"ready",Json.bool(m,"ready",false),"detail",shortText(Json.str(m,"detail",""),300),"activeCount",Math.max(0,Math.min(20,Json.num(m,"activeCount",0))),"lastSeen",System.currentTimeMillis()));
                send(x,200,Json.map("ok",true));return;
            }
            if(path.equals("/api/conversations")){
                if(method.equals("GET")){send(x,200,Json.map("conversations",workspaces.listConversations(principal)));return;}
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);
                synchronized(workspaceLock){send(x,201,workspaces.createConversation(accountId,Json.str(m,"id",UUID.randomUUID().toString()),Json.str(m,"title","新对话")));}return;
            }
            if(path.startsWith("/api/conversations/")){
                String[] p=path.substring(19).split("/",-1);if(p.length>2)throw new TaskStore.Missing("接口不存在");WorkspaceStore.validId(p[0]);
                synchronized(workspaceLock){
                    var c=workspaces.scopedConversation(principal,p[0]);
                    if(p.length==2&&p[1].equals("tasks")){require(method,"GET");send(x,200,Json.map("conversation",c,"tasks",store.list(Json.str(c,"accountId",""),p[0],true)));return;}
                    if(p.length!=1)throw new TaskStore.Missing("接口不存在");
                    if(method.equals("DELETE")){store.deleteConversation(p[0]);workspaces.delete(p[0]);send(x,200,Json.map("ok",true));return;}
                    if(method.equals("POST")){var m=body(x);if(m.containsKey("title"))workspaces.rename(p[0],Json.str(m,"title",""));if(m.containsKey("pinned"))workspaces.pin(p[0],Json.bool(m,"pinned",false));if(!m.containsKey("title")&&!m.containsKey("pinned"))throw new IllegalArgumentException("需要 title 或 pinned");send(x,200,workspaces.conversation(p[0]));return;}
                    require(method,"GET");send(x,200,c);return;
                }
            }
            if(path.equals("/api/tasks")){
                if(method.equals("GET")){send(x,200,Json.map("tasks",store.list(accountId,null,false)));return;}
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);String id=Json.str(m,"requestId","");String message=Json.str(m,"message","").trim();String conversationId=Json.str(m,"conversationId","");String requestedModel=Json.str(m,"model","").trim();var attachments=imageAttachments(m.get("attachments"),3,1_500_000,1_800_000);
                if(m.containsKey("accountId")&&!accountId.equals(Json.str(m,"accountId","")))throw new WorkspaceStore.Forbidden("禁止向其他账号创建任务");
                if(!id.matches("[A-Za-z0-9_-]{8,80}"))throw new IllegalArgumentException("requestId 必须为 8–80 位字母、数字、下划线或横线");
                if(message.isEmpty()&&!attachments.isEmpty())message="请查看并分析这张图片。";
                if(message.isEmpty()||message.length()>32_000)throw new IllegalArgumentException("消息须为 1–32000 字符，或至少附带一张图片");
                if(!attachments.isEmpty()&&!config.provider.equals("browser"))throw new IllegalArgumentException("图片目前仅支持 browser 网页桥接模式");
                if(!Set.of("","gpt-5-6","gpt-5-6-thinking","gpt-5-6-thinking-standard","gpt-5-6-thinking-extended","gpt-5-6-thinking-max","gpt-5-6-pro","gpt-6-pro").contains(requestedModel))throw new IllegalArgumentException("不支持的模型选择");
                synchronized(workspaceLock){
                    var c=workspaces.scopedConversation(principal,conversationId);
                    if(Json.bool(c,"blocked",false))throw new TaskStore.Conflict("此会话需要人工核对："+Json.str(c,"blockReason",""));
                    // Returning an existing request is safe even when its outcome was uncertain.
                    TaskStore.Task existing=store.all().stream().filter(t->t.accountId.equals(accountId)&&t.conversationId.equals(conversationId)&&t.requestId.equals(id)).findFirst().orElse(null);
                    if(existing!=null){if(!existing.message.equals(message)||!existing.attachments.equals(attachments)||!existing.model.equals(requestedModel))throw new TaskStore.Conflict("同一 requestId 不能对应不同消息、图片或模型");send(x,202,store.view(existing.id));return;}
                    boolean uncertain=store.all().stream().anyMatch(t->t.conversationId.equals(conversationId)&&t.submitted&&t.terminal()&&WorkspaceStore.canonicalChatUrl(Json.str(t.checkpoint,"url","")).isEmpty());
                    if(uncertain&&Json.str(c,"upstreamUrl","").isEmpty())throw new TaskStore.Conflict("上次提交没有确认上游会话地址。请到工作网页核对，另建新会话，不会自动重发或绑定其他对话。");
                    boolean first=store.list(accountId,conversationId,false).isEmpty();
                    var t=store.create(id,message,accountId,conversationId,attachments,requestedModel);
                    if(first&&Json.str(c,"title","").equals("新对话"))workspaces.rename(conversationId,message.replaceAll("\\s+"," ").substring(0,Math.min(50,message.replaceAll("\\s+"," ").length())));
                    else workspaces.touch(conversationId);
                    upstream.submit(t);send(x,202,store.view(t.id));return;
                }
            }
            if(path.equals("/api/history")){
                require(method,"DELETE");synchronized(workspaceLock){send(x,200,Json.map("ok",true,"deleted",store.clearHistory(accountId)));}return;
            }
            if(path.startsWith("/api/browser/files/")){
                require(method,"POST");WorkspaceStore.requireAccount(principal);String id=path.substring(19);if(!id.matches("[A-Za-z0-9_-]{8,80}"))throw new TaskStore.Missing("任务不存在");
                var t=scopedTask(principal,id);String client=x.getRequestHeaders().getFirst("X-Doubao-Client"),lease=x.getRequestHeaders().getFirst("X-Doubao-Lease"),key=x.getRequestHeaders().getFirst("X-Doubao-File-Key");
                workspaces.checkClient(accountId,client==null?"":client);if(!t.owner.equals(client)||!t.lease.equals(lease)||lease==null||lease.isEmpty())throw new TaskStore.Conflict("文件上传租约或浏览器所有权不匹配");
                if(key==null||!key.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("文件指纹无效");Map<String,Object> existing=store.existingFile(id,key);if(existing!=null){send(x,200,existing);return;}
                String encoded=x.getRequestHeaders().getFirst("X-Doubao-File-Name"),name;try{name=URLDecoder.decode(encoded==null?"":encoded,StandardCharsets.UTF_8);}catch(Exception e){throw new IllegalArgumentException("文件名编码无效");}
                name=name.trim();if(name.isEmpty()||name.length()>160||name.contains("/")||name.contains("\\")||name.chars().anyMatch(ch->ch<32))throw new IllegalArgumentException("文件名无效");
                String mime=Optional.ofNullable(x.getRequestHeaders().getFirst("Content-Type")).orElse("application/octet-stream").split(";",2)[0].trim().toLowerCase(Locale.ROOT);if(!mime.matches("[a-z0-9.+-]+/[a-z0-9.+-]+"))mime="application/octet-stream";
                String fileId=UUID.randomUUID().toString();Path target=store.filePath(id,fileId);long size=receiveFile(x,target,50_000_000);Map<String,Object> file=Json.map("id",fileId,"name",name,"mimeType",mime,"size",size,"key",key);
                try{store.addFile(id,lease,client,file);}catch(Exception e){Files.deleteIfExists(target);throw e;}send(x,201,Json.map("id",fileId,"name",name,"mimeType",mime,"size",size));return;
            }
            if(path.startsWith("/api/tasks/")){
                String[] p=path.substring(11).split("/",-1);if(p.length>3||!p[0].matches("[A-Za-z0-9_-]{8,80}"))throw new TaskStore.Missing("接口不存在");
                String id=p[0];var t=scopedTask(principal,id);
                if(p.length==3&&p[1].equals("files")){
                    require(method,"GET");Map<String,Object> file=store.file(id,p[2]);Path saved=store.filePath(id,p[2]);if(!Files.isRegularFile(saved))throw new TaskStore.Missing("文件不存在或已被清理");
                    String name=Json.str(file,"name","download.bin"),mime=Json.str(file,"mimeType","application/octet-stream"),quoted=URLEncoder.encode(name,StandardCharsets.UTF_8).replace("+","%20");
                    x.getResponseHeaders().set("Content-Type",mime);x.getResponseHeaders().set("Content-Disposition","attachment; filename=\"download\"; filename*=UTF-8''"+quoted);x.getResponseHeaders().set("Cache-Control","no-store");x.sendResponseHeaders(200,Files.size(saved));try(InputStream in=Files.newInputStream(saved)){in.transferTo(x.getResponseBody());}return;
                }
                if(p.length==1){
                    if(method.equals("DELETE")){synchronized(workspaceLock){store.delete(id);}send(x,200,Json.map("ok",true));return;}
                    require(method,"GET");send(x,200,store.view(id));return;
                }
                if(p[1].equals("cancel")){require(method,"POST");body(x);store.cancel(id);send(x,200,store.view(id));return;}
                if(p[1].equals("events")){require(method,"GET");stream(x,id);return;}
                throw new TaskStore.Missing("接口不存在");
            }
            if(path.equals("/api/browser/poll")){
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);String clientId=clientId(m);workspaces.checkClient(accountId,clientId);
                String conversationId=Json.str(m,"conversationId","");workspaces.scopedConversation(principal,conversationId);
                int wait=(int)Math.max(0,Math.min(18,Json.num(m,"waitSeconds",0)));
                if(!polls.tryAcquire()){send(x,429,Json.map("error","扩展轮询过多"));return;}
                try{send(x,200,Json.map("task",store.claim(accountId,conversationId,clientId,wait)));}finally{polls.release();}return;
            }
            if(path.equals("/api/browser/event")){
                require(method,"POST");WorkspaceStore.requireAccount(principal);var m=body(x);String clientId=clientId(m);workspaces.checkClient(accountId,clientId);
                synchronized(workspaceLock){
                    var t=scopedTask(principal,Json.str(m,"id",""));
                    if(!t.conversationId.equals(Json.str(m,"conversationId",""))||!t.owner.equals(clientId))throw new TaskStore.Conflict("事件的账号、会话或浏览器所有权不匹配");
                    if(!t.lease.equals(Json.str(m,"lease",""))||t.lease.isEmpty())throw new TaskStore.Conflict("租约不匹配，拒绝旧任务回传");
                    if(m.containsKey("images"))m.put("images",imageAttachments(m.get("images"),4,6_000_000,8_000_000));store.validateEvent(m);
                    // A terminal or replayed event cannot change conversation metadata.
                    if(!t.terminal()&&Json.num(m,"seq",0)>t.lastSeq&&m.get("checkpoint") instanceof Map<?,?> checkpoint){
                        Object url=checkpoint.get("url");if(url instanceof String u)workspaces.bindUrl(t.conversationId,u);
                    }
                    send(x,200,store.event(m));
                }return;
            }
            if(path.equals("/admin/shutdown")){
                require(method,"POST");WorkspaceStore.requireAdmin(principal);body(x);send(x,200,Json.map("ok",true));
                Thread.ofVirtual().start(()->{try{Thread.sleep(200);}catch(InterruptedException ignored){}stop();System.exit(0);});return;
            }
            throw new TaskStore.Missing("接口不存在；请同时更新网页、扩展和后端至 "+VERSION);
        }catch(WorkspaceStore.Forbidden e){safeError(x,403,e.getMessage());}
        catch(TaskStore.Missing e){safeError(x,404,e.getMessage());}
        catch(TaskStore.Conflict e){safeError(x,409,e.getMessage());}
        catch(MethodError e){safeError(x,405,e.getMessage());}
        catch(BodyTooLarge e){safeError(x,413,e.getMessage());}
        catch(IllegalArgumentException e){safeError(x,400,e.getMessage());}
        catch(InterruptedException e){Thread.currentThread().interrupt();safeError(x,503,"服务正在重启，请稍后重试");}
        catch(IOException e){if(x.getResponseCode()==-1){System.err.println("[ERROR] Request I/O failure: "+e.getClass().getSimpleName());safeError(x,500,"本地读写失败，请检查磁盘空间、权限或重新连接");}}
        catch(Exception e){System.err.println("[ERROR] Request failure: "+e.getClass().getSimpleName());safeError(x,500,"后端内部错误，请查看日志");}
        finally{requests.release();x.close();}
    }
    TaskStore.Task scopedTask(WorkspaceStore.Principal principal,String id){
        var t=store.task(id);if(!principal.admin()&&!principal.accountId().equals(t.accountId))throw new TaskStore.Missing("任务不存在");return t;
    }
    List<Map<String,Object>> visibleBridges(String accountId,long ttl){return bridges.values().stream().filter(b->(accountId==null||accountId.equals(Json.str(b,"accountId","")))&&System.currentTimeMillis()-Json.num(b,"lastSeen",0)<ttl).toList();}
    boolean security(HttpExchange x)throws IOException{
        if(x.getRemoteAddress()==null||!x.getRemoteAddress().getAddress().isLoopbackAddress()){send(x,403,Json.map("error","Loopback only"));return false;}
        String host=x.getRequestHeaders().getFirst("Host");
        if(!Set.of("127.0.0.1:"+config.port,"localhost:"+config.port).contains(host==null?"":host.toLowerCase(Locale.ROOT))){send(x,403,Json.map("error","Invalid Host"));return false;}
        String origin=x.getRequestHeaders().getFirst("Origin");
        boolean allowed=origin==null||origin.equals("http://127.0.0.1:"+config.port)||origin.equals("http://localhost:"+config.port)||origin.matches("chrome-extension://[a-p]{32}");
        if(!allowed){send(x,403,Json.map("error","Origin not allowed"));return false;}
        Headers h=x.getResponseHeaders();h.set("X-Content-Type-Options","nosniff");h.set("Referrer-Policy","no-referrer");
        h.set("Cache-Control","no-store");h.set("Vary","Origin");
        if(origin!=null){h.set("Access-Control-Allow-Origin",origin);h.set("Access-Control-Allow-Headers","Authorization, Content-Type, Last-Event-ID");h.set("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS");h.set("Access-Control-Allow-Private-Network","true");}
        return true;
    }
    boolean authorized(HttpExchange x){
        String actual=x.getRequestHeaders().getFirst("Authorization");
        return actual!=null&&MessageDigest.isEqual(("Bearer "+token).getBytes(StandardCharsets.UTF_8),actual.getBytes(StandardCharsets.UTF_8));
    }
    static String clientId(Map<String,Object> m){String id=Json.str(m,"clientId","");if(!id.matches("[A-Za-z0-9_-]{8,100}"))throw new IllegalArgumentException("Invalid clientId");return id;}
    static String shortText(String s,int max){return s.substring(0,Math.min(s.length(),max));}
    @SuppressWarnings("unchecked") static List<Map<String,Object>> imageAttachments(Object raw,int maxCount,int maxEach,long maxTotal){
        if(raw==null)return List.of();if(!(raw instanceof List<?> list))throw new IllegalArgumentException("图片附件格式无效");
        if(list.size()>maxCount)throw new IllegalArgumentException("图片数量超过限制");
        var out=new ArrayList<Map<String,Object>>();long total=0;
        for(Object item:list){
            if(!(item instanceof Map<?,?> source))throw new IllegalArgumentException("图片附件格式无效");
            var m=(Map<String,Object>)source;String name=Json.str(m,"name","图片").trim(),type=Json.str(m,"mimeType","").toLowerCase(Locale.ROOT),data=Json.str(m,"base64","");
            if(name.isEmpty()||name.length()>120||name.contains("/")||name.contains("\\"))throw new IllegalArgumentException("图片文件名无效");
            if(!Set.of("image/png","image/jpeg","image/webp","image/gif").contains(type))throw new IllegalArgumentException("仅支持 PNG、JPEG、WebP 或 GIF 图片");
            byte[] decoded;try{decoded=Base64.getDecoder().decode(data);}catch(IllegalArgumentException e){throw new IllegalArgumentException("图片数据损坏或不是 Base64");}
            if(decoded.length==0||decoded.length>maxEach)throw new IllegalArgumentException("单张图片超过大小限制");
            total+=decoded.length;if(total>maxTotal)throw new IllegalArgumentException("图片总大小超过限制");
            out.add(Json.map("name",name,"mimeType",type,"base64",data));
        }return List.copyOf(out);
    }
    static Map<String,Object> body(HttpExchange x)throws IOException{
        String ct=x.getRequestHeaders().getFirst("Content-Type");
        if(ct==null||!ct.toLowerCase(Locale.ROOT).startsWith("application/json"))throw new IllegalArgumentException("Content-Type must be application/json");
        // Hard cap on UTF-8 wire bytes, independent of Content-Length.
        byte[] b=x.getRequestBody().readNBytes(12_000_001);if(b.length>12_000_000)throw new BodyTooLarge("请求体过大");
        return Json.object(new String(b,StandardCharsets.UTF_8));
    }
    static long receiveFile(HttpExchange x,Path target,long max)throws IOException{
        Files.createDirectories(target.getParent());Path tmp=target.resolveSibling(target.getFileName()+".tmp");long total=0;
        try(InputStream in=x.getRequestBody();OutputStream out=Files.newOutputStream(tmp,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING)){
            byte[] buffer=new byte[64*1024];for(int n;(n=in.read(buffer))>=0;){if(n==0)continue;total+=n;if(total>max)throw new BodyTooLarge("单个生成文件不能超过 50 MB");out.write(buffer,0,n);}
            if(total==0)throw new IllegalArgumentException("生成文件为空");
        }catch(RuntimeException|IOException e){Files.deleteIfExists(tmp);throw e;}
        try{Files.move(tmp,target,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(tmp,target,StandardCopyOption.REPLACE_EXISTING);}return total;
    }
    void stream(HttpExchange x,String id)throws Exception{
        if(!streams.tryAcquire()){send(x,429,Json.map("error","订阅过多，请关闭重复窗口"));return;}
        try{
            var h=x.getResponseHeaders();h.set("Content-Type","text/event-stream; charset=utf-8");h.set("Cache-Control","no-cache, no-transform");h.set("X-Accel-Buffering","no");
            x.sendResponseHeaders(200,0);
            try(OutputStream out=x.getResponseBody()){
                long version=-1; // Always send the latest full snapshot, including after a reconnect.
                while(!stopping){
                    var task=store.await(id,version,10_000);long next=Json.num(task,"version",0);
                    if(next!=version){
                        out.write(("id: "+next+"\nevent: snapshot\ndata: "+Json.stringify(task)+"\n\n").getBytes(StandardCharsets.UTF_8));version=next;
                    }else out.write(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();if(TaskStore.TERMINAL.contains(Json.str(task,"state","")))break;
                }
            }
        }finally{streams.release();}
    }
    void staticFile(HttpExchange x,String path)throws IOException{
        // Canonicalize the UI origin so CSP connect-src self and IPv4 requests agree.
        if(("localhost:"+config.port).equalsIgnoreCase(x.getRequestHeaders().getFirst("Host"))
                && Set.of("/","/web","/web/","/web/app.html","/app.html").contains(path)){
            x.getResponseHeaders().set("Location","http://127.0.0.1:"+config.port+"/web/");
            x.sendResponseHeaders(302,-1);return;
        }
        if(path.equals("/")||path.equals("/web")){
            x.getResponseHeaders().set("Location","/web/");x.sendResponseHeaders(302,-1);return;
        }
        String name=path.equals("/web/")?"app.html":path.startsWith("/web/")?path.substring(5):path.substring(1);
        if(!Set.of("app.html","app.css","app.js","shared.js","web-rpc.js","render.js","icon.svg","avatar.png").contains(name)){send(x,404,Json.map("error","Not found"));return;}
        InputStream stream=BackendServer.class.getResourceAsStream("/ui/"+name);
        if(stream==null){Path file=Path.of("web",name);if(Files.isRegularFile(file))stream=Files.newInputStream(file);}
        if(stream==null){send(x,404,Json.map("error","UI assets missing; run build.bat"));return;}
        byte[] bytes;try(InputStream in=stream){bytes=in.readAllBytes();}
        String type=name.endsWith(".css")?"text/css":name.endsWith(".js")?"text/javascript":name.endsWith(".svg")?"image/svg+xml":name.endsWith(".png")?"image/png":"text/html";
        x.getResponseHeaders().set("Content-Type",type+(type.startsWith("text/")||type.endsWith("svg+xml")?"; charset=utf-8":""));
        x.getResponseHeaders().set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        x.sendResponseHeaders(200,bytes.length);x.getResponseBody().write(bytes);
    }
    static void require(String actual,String wanted){if(!actual.equals(wanted))throw new MethodError("Method must be "+wanted);}
    static void send(HttpExchange x,int code,Object value)throws IOException{
        byte[] b=Json.stringify(value).getBytes(StandardCharsets.UTF_8);x.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");x.sendResponseHeaders(code,b.length);x.getResponseBody().write(b);
    }
    static void safeError(HttpExchange x,int code,String error){if(x.getResponseCode()!=-1)return;try{Object detail=x.getRequestURI().getPath().startsWith("/v1/")?Json.map("message",error,"type",code>=500?"server_error":"invalid_request_error","code",code):error;send(x,code,Json.map("error",detail));}catch(IOException ignored){}}
    static final class MethodError extends RuntimeException{MethodError(String m){super(m);}}
    static final class BodyTooLarge extends RuntimeException{BodyTooLarge(String m){super(m);}}
}
