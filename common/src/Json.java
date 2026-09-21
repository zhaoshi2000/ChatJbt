import java.util.*;

/** Small strict JSON codec; no regex field extraction, no third-party runtime. */
public final class Json {
    private Json() {}
    public static Object parse(String input) {
        Parser p = new Parser(input);
        Object value = p.value(0);
        p.ws();
        if (p.pos != input.length()) throw p.error("Trailing data");
        return value;
    }
    @SuppressWarnings("unchecked")
    public static Map<String,Object> object(String input) {
        Object value = parse(input);
        if (!(value instanceof Map)) throw new IllegalArgumentException("Expected JSON object");
        return (Map<String,Object>) value;
    }
    public static String str(Map<String,Object> m, String key, String fallback) {
        Object v = m.get(key); return v instanceof String s ? s : fallback;
    }
    public static long num(Map<String,Object> m, String key, long fallback) {
        Object v = m.get(key); return v instanceof Number n ? n.longValue() : fallback;
    }
    public static boolean bool(Map<String,Object> m, String key, boolean fallback) {
        Object v = m.get(key); return v instanceof Boolean b ? b : fallback;
    }
    public static Map<String,Object> map(Object... pairs) {
        if (pairs.length % 2 != 0) throw new IllegalArgumentException("Key/value pairs required");
        Map<String,Object> m = new LinkedHashMap<>();
        for (int i=0;i<pairs.length;i+=2) m.put((String)pairs[i],pairs[i+1]);
        return m;
    }
    public static String stringify(Object value) {
        StringBuilder b = new StringBuilder(); write(value,b,0); return b.toString();
    }
    private static void write(Object value, StringBuilder b, int depth) {
        if (depth>64) throw new IllegalArgumentException("JSON nesting limit exceeded");
        if (value==null) b.append("null");
        else if (value instanceof String s) {
            b.append('"');
            for(int i=0;i<s.length();i++) {
                char c=s.charAt(i);
                switch(c) {
                    case '"' -> b.append("\\\""); case '\\' -> b.append("\\\\");
                    case '\n' -> b.append("\\n"); case '\r' -> b.append("\\r");
                    case '\t' -> b.append("\\t"); case '\b' -> b.append("\\b");
                    case '\f' -> b.append("\\f");
                    default -> { if(c<32) b.append(String.format("\\u%04x",(int)c)); else b.append(c); }
                }
            }
            b.append('"');
        } else if (value instanceof Boolean) b.append(value);
        else if (value instanceof Number n) {
            if(!Double.isFinite(n.doubleValue())) throw new IllegalArgumentException("Non-finite number");
            b.append(n);
        } else if(value instanceof Map<?,?> m) {
            b.append('{'); boolean first=true;
            for(var e:m.entrySet()) {
                if(!(e.getKey() instanceof String)) throw new IllegalArgumentException("String keys required");
                if(!first)b.append(','); first=false;
                write(e.getKey(),b,depth+1); b.append(':'); write(e.getValue(),b,depth+1);
            } b.append('}');
        } else if(value instanceof Iterable<?> list) {
            b.append('['); boolean first=true;
            for(Object v:list){if(!first)b.append(',');first=false;write(v,b,depth+1);} b.append(']');
        } else throw new IllegalArgumentException("Unsupported JSON value");
    }
    private static final class Parser {
        final String s; int pos;
        Parser(String s){this.s=Objects.requireNonNull(s);}
        IllegalArgumentException error(String msg){return new IllegalArgumentException(msg+" at "+pos);}
        void ws(){while(pos<s.length() && " \r\n\t".indexOf(s.charAt(pos))>=0)pos++;}
        boolean take(char c){ws();if(pos<s.length()&&s.charAt(pos)==c){pos++;return true;}return false;}
        Object value(int depth) {
            if(depth>64)throw error("JSON nesting limit exceeded");
            ws();if(pos>=s.length())throw error("Unexpected end");
            char c=s.charAt(pos);
            if(c=='"')return string();
            if(c=='{'){
                pos++;Map<String,Object> m=new LinkedHashMap<>();if(take('}'))return m;
                do{ws();String k=string();if(!take(':'))throw error("Expected colon");
                    if(m.containsKey(k))throw error("Duplicate key");m.put(k,value(depth+1));
                }while(take(','));
                if(!take('}'))throw error("Expected closing brace");return m;
            }
            if(c=='['){pos++;List<Object> l=new ArrayList<>();if(take(']'))return l;
                do{l.add(value(depth+1));}while(take(','));
                if(!take(']'))throw error("Expected closing bracket");return l;
            }
            for(String literal:List.of("true","false","null"))if(s.startsWith(literal,pos)){
                pos+=literal.length();return literal.equals("null")?null:literal.equals("true");
            }
            int start=pos;if(c=='-')pos++;
            if(pos>=s.length())throw error("Invalid number");
            if(s.charAt(pos)=='0')pos++;
            else{int p=pos;while(pos<s.length()&&Character.isDigit(s.charAt(pos)))pos++;if(p==pos)throw error("Invalid value");}
            boolean floating=false;
            if(pos<s.length()&&s.charAt(pos)=='.'){floating=true;pos++;int p=pos;while(pos<s.length()&&Character.isDigit(s.charAt(pos)))pos++;if(p==pos)throw error("Invalid fraction");}
            if(pos<s.length()&&"eE".indexOf(s.charAt(pos))>=0){floating=true;pos++;if(pos<s.length()&&"+-".indexOf(s.charAt(pos))>=0)pos++;
                int p=pos;while(pos<s.length()&&Character.isDigit(s.charAt(pos)))pos++;if(p==pos)throw error("Invalid exponent");}
            try {String n=s.substring(start,pos);if(!floating)return Long.valueOf(n);double d=Double.parseDouble(n);if(!Double.isFinite(d))throw error("Non-finite number");return d;}
            catch(NumberFormatException e){throw error("Invalid number");}
        }
        String string(){
            if(pos>=s.length()||s.charAt(pos++)!='"')throw error("Expected string");
            StringBuilder b=new StringBuilder();
            while(pos<s.length()){
                char c=s.charAt(pos++);if(c=='"')return b.toString();if(c<32)throw error("Control character");
                if(c!='\\'){b.append(c);continue;}
                if(pos>=s.length())throw error("Unfinished escape");
                char e=s.charAt(pos++);
                switch(e){
                    case '"','\\','/' -> b.append(e);case 'n' -> b.append('\n');case 'r' -> b.append('\r');
                    case 't' -> b.append('\t');case 'b' -> b.append('\b');case 'f' -> b.append('\f');
                    case 'u' -> {if(pos+4>s.length())throw error("Unfinished Unicode escape");
                        try{b.append((char)Integer.parseInt(s.substring(pos,pos+4),16));}catch(NumberFormatException ex){throw error("Invalid Unicode escape");}pos+=4;}
                    default -> throw error("Invalid escape");
                }
            }throw error("Unterminated string");
        }
    }
}
