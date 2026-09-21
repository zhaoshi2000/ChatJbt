import java.util.*;
public class JsonTest {
    static int tests;
    static void check(boolean ok,String name){if(!ok)throw new AssertionError(name);tests++;}
    static void reject(String value){try{Json.parse(value);throw new AssertionError("Accepted "+value);}catch(IllegalArgumentException expected){tests++;}}
    public static void main(String[]args){
        var value=Json.map("text","中文🌲\n\"\\\t", "array",Arrays.asList(1L,true,null),"nested",Json.map("ok",false));
        check(Json.object(Json.stringify(value)).equals(value),"round trip");
        check(Json.num(Json.object("{\"n\":9007199254740993}"),"n",0)==9007199254740993L,"large integer");
        check(Json.parse("\"\\u4f60\\u597d\"").equals("你好"),"unicode");
        check(Json.parse(" -1.25e2 ").equals(-125.0),"number exponent");
        for(String s:List.of("{\"a\":1,\"a\":2}","[1,]","{\"a\":1,}","01","true garbage","\"bad\nstring\"","\"\\q\"","1e","1.","1e999","[".repeat(70)+"]".repeat(70)))reject(s);
        try{Json.stringify(Double.NaN);throw new AssertionError("NaN");}catch(IllegalArgumentException expected){tests++;}
        System.out.println("JSON codec: "+tests+" assertions passed");
    }
}
