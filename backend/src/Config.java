import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

final class Config {
    final int port, timeoutSeconds, queueMax, historyMax, concurrent;
    final String provider, apiKey, model, apiBase;
    final Path data;
    Config() throws IOException {
        Properties p=new Properties();
        Path file=Path.of(System.getenv().getOrDefault("CHAT_CONFIG","config/application.properties"));
        if(Files.exists(file))try(Reader r=Files.newBufferedReader(file,StandardCharsets.UTF_8)){p.load(r);}
        port=integer(p,"PORT","server.port",48643,1024,65535);
        timeoutSeconds=integer(p,"TASK_TIMEOUT_SECONDS","task.timeout.seconds",900,30,7200);
        queueMax=integer(p,"QUEUE_MAX","queue.max",20,1,100);
        historyMax=integer(p,"HISTORY_MAX","history.max",2000,1,20000);
        concurrent=integer(p,"BRIDGE_CONCURRENT","bridge.concurrent",3,1,5);
        provider=value(p,"PROVIDER","provider","browser").toLowerCase(Locale.ROOT);
        if(!Set.of("browser","mock","openai").contains(provider))throw new IllegalArgumentException("PROVIDER must be browser, mock or openai");
        apiKey=System.getenv().getOrDefault("OPENAI_API_KEY","").trim();
        model=value(p,"OPENAI_MODEL","openai.model","");
        apiBase=value(p,"OPENAI_BASE_URL","openai.base-url","https://api.openai.com/v1").replaceAll("/+$","");
        var uri=java.net.URI.create(apiBase);
        if(uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null ||
           !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && Set.of("127.0.0.1","localhost").contains(uri.getHost()))))
            throw new IllegalArgumentException("OPENAI_BASE_URL must be HTTPS (or loopback HTTP for tests)");
        if(provider.equals("openai")&&(apiKey.isEmpty()||model.isEmpty()))
            throw new IllegalArgumentException("OpenAI mode requires OPENAI_API_KEY and OPENAI_MODEL; never uses a made-up model name");
        data=Path.of(value(p,"DATA_DIR","data.dir","data")).toAbsolutePath().normalize();
        Files.createDirectories(data);
    }
    static String value(Properties p,String env,String key,String fallback){return System.getenv().getOrDefault(env,p.getProperty(key,fallback)).trim();}
    static int integer(Properties p,String env,String key,int fallback,int min,int max){
        int n=Integer.parseInt(value(p,env,key,""+fallback));if(n<min||n>max)throw new IllegalArgumentException(key+" out of range");return n;
    }
}
