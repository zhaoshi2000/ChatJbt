import java.io.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.net.URI;
import java.security.*;
import java.util.*;

/** Account-scoped credentials and conversation metadata. No upstream credentials/cookies. */
final class WorkspaceStore {
    record Principal(boolean admin, String accountId) {}
    final Path file;
    final LinkedHashMap<String,Map<String,Object>> accounts=new LinkedHashMap<>();
    final LinkedHashMap<String,Map<String,Object>> conversations=new LinkedHashMap<>();
    WorkspaceStore(Config config)throws IOException {
        file=config.data.resolve("workspaces.json");
        if(Files.exists(file)) {
            var root=Json.object(Files.readString(file,StandardCharsets.UTF_8));
            load(root,"accounts",accounts);load(root,"conversations",conversations);
            for(var c:conversations.values())if(!accounts.containsKey(Json.str(c,"accountId","")))
                throw new IOException("会话缺少所属账号，拒绝启动；请从备份恢复 workspaces.json");
        }
    }
    @SuppressWarnings("unchecked") static void load(Map<String,Object> root,String key,Map<String,Map<String,Object>> target)throws IOException {
        if(!(root.get(key) instanceof List<?> list))throw new IOException("workspaces.json 格式错误："+key);
        for(Object item:list){if(!(item instanceof Map<?,?> map))throw new IOException("Invalid workspace record");
            var m=new LinkedHashMap<>((Map<String,Object>)map);String id=Json.str(m,"id","");
            validId(id);if(target.put(id,m)!=null)throw new IOException("Duplicate workspace ID");}
    }
    static void validId(String id){if(!id.matches("[A-Za-z0-9_-]{8,100}"))throw new IllegalArgumentException("无效的账号或会话 ID");}
    static String hash(String token){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));}catch(NoSuchAlgorithmException e){throw new AssertionError(e);}}
    static String newToken(){byte[] b=new byte[32];new SecureRandom().nextBytes(b);return Base64.getUrlEncoder().withoutPadding().encodeToString(b);}
    static boolean constant(String a,String b){return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8),b.getBytes(StandardCharsets.UTF_8));}
    synchronized Principal authenticate(String bearer,String master) {
        if(bearer==null||!bearer.startsWith("Bearer "))return null;
        String token=bearer.substring(7);if(constant(token,master))return new Principal(true,"");
        String digest=hash(token);
        for(var a:accounts.values())if(constant(digest,Json.str(a,"tokenHash","")))return new Principal(false,Json.str(a,"id",""));
        return null;
    }
    static void requireAdmin(Principal p){if(!p.admin)throw new Forbidden("需要本机管理员令牌；账号令牌不能管理其他账号");}
    static void requireAccount(Principal p){if(p.admin)throw new Forbidden("请先创建账号工作区，并用该账号的专属令牌配对；管理员令牌不能直接执行对话");}
    synchronized Map<String,Object> account(String id){var a=accounts.get(id);if(a==null)throw new TaskStore.Missing("账号不存在");return a;}
    synchronized Map<String,Object> accountView(String id){var out=new LinkedHashMap<>(account(id));out.remove("tokenHash");return out;}
    synchronized List<Map<String,Object>> accountList(Principal p){return accounts.keySet().stream().filter(id->p.admin||id.equals(p.accountId)).map(this::accountView).toList();}
    synchronized Map<String,Object> createAccount(String name)throws IOException {
        name=name.trim();if(name.isEmpty()||name.length()>60)throw new IllegalArgumentException("账号名称需为 1–60 字符");
        if(accounts.size()>=30)throw new TaskStore.Conflict("本地版最多 30 个账号工作区");
        final String label=name;
        if(accounts.values().stream().anyMatch(a->Json.str(a,"name","").equalsIgnoreCase(label)))throw new TaskStore.Conflict("这个账号名称已存在；请使用原账号令牌，或在管理窗口重置令牌");
        String id=UUID.randomUUID().toString(),token=newToken();
        var a=Json.map("id",id,"name",name,"tokenHash",hash(token),"created",System.currentTimeMillis(),"clientId","","profileLabel","");
        accounts.put(id,a);try{save();}catch(IOException e){accounts.remove(id);throw e;}
        return Json.map("account",accountView(id),"token",token);
    }
    synchronized Map<String,Object> rotate(String id)throws IOException {
        var a=account(id);var before=new LinkedHashMap<>(a);String token=newToken();
        a.put("tokenHash",hash(token));a.put("clientId","");a.put("profileLabel","");
        try{save();}catch(IOException e){accounts.put(id,before);throw e;}
        return Json.map("account",accountView(id),"token",token);
    }
    synchronized Map<String,Object> register(String accountId,String clientId,String label)throws IOException {
        validId(clientId);var a=account(accountId);String owner=Json.str(a,"clientId","");
        if(!owner.isEmpty()&&!owner.equals(clientId))throw new TaskStore.Conflict("该账号已绑定另一个浏览器配置文件。不要跨配置文件共用账号令牌；重新安装扩展后请先在账号管理中重置绑定。");
        for(var other:accounts.values())if(!Json.str(other,"id","").equals(accountId)&&Json.str(other,"clientId","").equals(clientId))
            throw new TaskStore.Conflict("这个浏览器配置文件已绑定其他账号。请为新账号使用独立的 Edge/Chrome 配置文件，不要在同一配置文件中切换登录。");
        if(owner.isEmpty()){
            var old=new LinkedHashMap<>(a);a.put("clientId",clientId);a.put("profileLabel",label.substring(0,Math.min(label.length(),80)));
            try{save();}catch(IOException e){accounts.put(accountId,old);throw e;}
        }
        return accountView(accountId);
    }
    synchronized void checkClient(String accountId,String clientId){
        validId(clientId);if(!Json.str(account(accountId),"clientId","").equals(clientId))throw new Forbidden("浏览器配置文件尚未绑定本账号，或绑定已被重置");
    }
    synchronized Map<String,Object> conversation(String id){var c=conversations.get(id);if(c==null)throw new TaskStore.Missing("会话不存在");return new LinkedHashMap<>(c);}
    synchronized Map<String,Object> scopedConversation(Principal p,String id){var c=conversation(id);if(!p.admin&&!p.accountId.equals(Json.str(c,"accountId","")))throw new TaskStore.Missing("会话不存在");return c;}
    synchronized List<Map<String,Object>> listConversations(Principal p){return conversations.values().stream().filter(c->p.admin||p.accountId.equals(Json.str(c,"accountId",""))).sorted(Comparator.comparing((Map<String,Object> c)->Json.bool(c,"pinned",false)).reversed().thenComparing(Comparator.comparingLong((Map<String,Object> c)->Json.num(c,Json.bool(c,"pinned",false)?"pinnedAt":"updated",0)).reversed())).map(c->(Map<String,Object>)new LinkedHashMap<>(c)).toList();}
    synchronized Map<String,Object> createConversation(String accountId,String id,String title)throws IOException {
        account(accountId);validId(id);title=title.trim();if(title.isEmpty())title="新对话";if(title.length()>100)throw new IllegalArgumentException("标题最多 100 字符");
        if(conversations.containsKey(id)){var c=conversation(id);if(!accountId.equals(Json.str(c,"accountId","")))throw new TaskStore.Missing("会话不存在");return c;}
        if(conversations.values().stream().filter(c->accountId.equals(Json.str(c,"accountId",""))).count()>=2000)throw new TaskStore.Conflict("此账号会话过多，请导出并删除部分记录");
        long now=System.currentTimeMillis();var c=Json.map("id",id,"accountId",accountId,"title",title,"created",now,"updated",now,"pinned",false,"pinnedAt",0,"upstreamUrl","","blocked",false,"blockReason","");
        conversations.put(id,c);try{save();}catch(IOException e){conversations.remove(id);throw e;}return new LinkedHashMap<>(c);
    }
    synchronized void rename(String id,String title)throws IOException {
        title=title.trim();if(title.isEmpty()||title.length()>100)throw new IllegalArgumentException("标题需为 1–100 字符");
        update(id,Json.map("title",title,"updated",System.currentTimeMillis()));
    }
    synchronized void pin(String id,boolean pinned)throws IOException {update(id,Json.map("pinned",pinned,"pinnedAt",pinned?System.currentTimeMillis():0));}
    synchronized void touch(String id)throws IOException {update(id,Json.map("updated",System.currentTimeMillis()));}
    synchronized void update(String id,Map<String,Object> values)throws IOException {
        var old=conversation(id);conversations.get(id).putAll(values);try{save();}catch(IOException e){conversations.put(id,old);throw e;}
    }
    static String canonicalChatUrl(String raw){
        try{URI u=URI.create(raw);String host=u.getHost(),path=u.getPath();
            if(!"https".equals(u.getScheme())||!Set.of("chatgpt.com","chat.openai.com").contains(host==null?"":host)||u.getUserInfo()!=null||u.getPort()!=-1)return "";
            if(!path.matches("/(?:g/[A-Za-z0-9_-]+/)?c/(?:WEB:)?[A-Za-z0-9_-]+"))return "";
            return "https://chatgpt.com"+path;
        }catch(Exception e){return "";}
    }
    synchronized void bindUrl(String id,String raw)throws IOException {
        String url=canonicalChatUrl(raw);if(url.isEmpty())return;
        var c=conversation(id);String previous=Json.str(c,"upstreamUrl","");
        if(!previous.isEmpty()&&!previous.equals(url))throw new TaskStore.Conflict("工作标签页已切换到其他上游会话，拒绝串写；请恢复原工作标签页");
        for(var other:conversations.values())if(!id.equals(Json.str(other,"id",""))&&Json.str(c,"accountId","").equals(Json.str(other,"accountId",""))&&url.equals(Json.str(other,"upstreamUrl","")))
            throw new TaskStore.Conflict("同一 ChatGPT 会话不能绑定两个不同本地会话");
        if(previous.isEmpty())update(id,Json.map("upstreamUrl",url,"updated",System.currentTimeMillis()));
    }
    synchronized void block(String id,String reason)throws IOException {update(id,Json.map("blocked",true,"blockReason",reason));}
    synchronized void delete(String id)throws IOException {var old=conversation(id);conversations.remove(id);try{save();}catch(IOException e){conversations.put(id,old);throw e;}}
    synchronized void save()throws IOException {atomic(file,Json.map("schema",2,"accounts",new ArrayList<>(accounts.values()),"conversations",new ArrayList<>(conversations.values())));}
    static void atomic(Path file,Object value)throws IOException {
        Path tmp=file.resolveSibling(file.getFileName()+".tmp");byte[] bytes=Json.stringify(value).getBytes(StandardCharsets.UTF_8);
        try(FileChannel ch=FileChannel.open(tmp,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE)){ByteBuffer b=ByteBuffer.wrap(bytes);while(b.hasRemaining())ch.write(b);ch.force(true);}
        try{Files.move(tmp,file,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(tmp,file,StandardCopyOption.REPLACE_EXISTING);}
    }
    static class Forbidden extends RuntimeException{Forbidden(String message){super(message);}}
}
