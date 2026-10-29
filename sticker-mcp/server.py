import base64, hashlib, hmac, io, json, os, re, sqlite3, time, uuid
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image,ImageDraw,UnidentifiedImageError

ROOT=Path(__file__).resolve().parent
DATA=Path(os.getenv("STICKERS_DATA_DIR","/tmp/xlc-stickers"))
FILES=DATA/"files"
DB=DATA/"stickers.sqlite"
MCP_KEY=os.getenv("MCP_PATH_KEY","")
ADMIN_KEY=os.getenv("ADMIN_KEY","")
PUBLIC=os.getenv("PUBLIC_BASE_URL","https://xlc-stickers.onrender.com").rstrip("/")
URI="ui://xlc-stickers/picker.html"
SINGLE_URI="ui://xlc-stickers/single.html"
MAX=6*1024*1024

def db():
    c=sqlite3.connect(DB,timeout=10)
    c.row_factory=sqlite3.Row
    return c

def setup():
    FILES.mkdir(parents=True,exist_ok=True)
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY,title TEXT,tags TEXT,category TEXT,ext TEXT,mime TEXT,sha TEXT UNIQUE,created INTEGER,demo INTEGER)")
    if not any(FILES.glob("*.png")):
        for i,(name,cat,tags,col) in enumerate([
          ("好耶","开心","快乐 开心","#ffe7a5"),("贴贴","撒娇","爱心 抱抱","#f9cadb"),
          ("哭哭","情绪","委屈 眼泪","#d4e8ff"),("晚安","日常","睡觉 困困","#e6dffc"),
          ("想你","撒娇","喜欢 亲亲","#ffdbe7"),("震惊","情绪","惊讶 啊","#cde5ff")]):
            image=Image.new("RGBA",(260,260),(0,0,0,0))
            d=ImageDraw.Draw(image)
            d.ellipse((20,20,240,240),fill=col,outline="#5d5560",width=5)
            d.ellipse((75,85,99,115),fill="#5d5560");d.ellipse((160,85,184,115),fill="#5d5560")
            d.arc((78,100,180,185),0,180,fill="#5d5560",width=7)
            b=io.BytesIO();image.save(b,"PNG")
            add_image(b.getvalue(),name,tags,cat,True)

def add_image(raw,title,tags,category,demo=False):
    if not raw or len(raw)>MAX:raise ValueError("图片大小不能超过6MB")
    try:
        with Image.open(io.BytesIO(raw)) as p:
            fmt=p.format
            if fmt not in ("PNG","JPEG","GIF","WEBP"):raise ValueError("只支持 PNG/JPEG/GIF/WebP")
            if p.width>3000 or p.height>3000:raise ValueError("图片像素超过3000x3000")
            p.verify()
    except (OSError,UnidentifiedImageError) as e:raise ValueError("无效的图片数据") from e
    ext={"PNG":"png","JPEG":"jpg","GIF":"gif","WEBP":"webp"}[fmt]
    mime={"PNG":"image/png","JPEG":"image/jpeg","GIF":"image/gif","WEBP":"image/webp"}[fmt]
    sha=hashlib.sha256(raw).hexdigest()
    with db() as c:
        prev=c.execute("SELECT id FROM stickers WHERE sha=?",(sha,)).fetchone()
        if prev:return prev["id"]
        sid=str(uuid.uuid4())
        (FILES/(sid+"."+ext)).write_bytes(raw)
        c.execute("INSERT INTO stickers VALUES(?,?,?,?,?,?,?,?,?)",
          (sid,str(title)[:65],str(tags)[:240],str(category)[:36],ext,mime,sha,int(time.time()),int(demo)))
        return sid

def get(sid):
    with db() as c:return c.execute("SELECT * FROM stickers WHERE id=?",(sid,)).fetchone()

def signed(row,thumb=True):
    kind="thumb" if thumb else "original"
    expiry=int(time.time())+900
    sig=hmac.new(MCP_KEY.encode(),f'{row["id"]}:{expiry}:{kind}'.encode(),hashlib.sha256).hexdigest()
    return f'{PUBLIC}/media/{row["id"]}/{kind}?exp={expiry}&sig={sig}'

def listing(query="",category="",limit=80):
    query=str(query).lower().strip()[:80]
    category=str(category).strip()[:36]
    with db() as c:rows=c.execute("SELECT * FROM stickers ORDER BY demo ASC,created DESC").fetchall()
    rows=[r for r in rows if (not query or query in (r["title"]+" "+r["tags"]+" "+r["category"]).lower()) and (not category or r["category"]==category)]
    return [{"id":r["id"],"title":r["title"],"tags":r["tags"].split(),"category":r["category"],
       "type":r["mime"],"demo":bool(r["demo"]),"preview_url":signed(r),"image_url":signed(r,False)}
       for r in rows[:max(1,min(int(limit),120))]]

WIDGET_META={"openai/widgetAccessible":True}
LIBRARY_META={"ui":{"resourceUri":URI},"openai/outputTemplate":URI,"openai/widgetAccessible":True}
SINGLE_META={"ui":{"resourceUri":SINGLE_URI},"openai/outputTemplate":SINGLE_URI,"openai/widgetAccessible":True}
TOOLS=[
 {"name":"search_stickers","title":"检索表情包","description":"当聊天情境自然适合表情时（例如想念、撒娇、安慰、开心或晚安），可主动在后台检索并自主挑选一张；每轮最多一张，不要机械地每条消息都发表情，也不必先询问用户。返回候选元数据供 AI 挑选，本工具不会打开或渲染图库。默认流程是先搜索，再调用 send_sticker 展示最匹配的一张。只有用户明确要求浏览/挑选图库时才调用 open_sticker_library。","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"category":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":120}}},"_meta":WIDGET_META},
 {"name":"send_sticker","title":"展示单张表情包","description":"把 AI 自主选中的一张表情包作为单图 MCP App 展示。适合时可主动使用，无须用户逐次点名；每次只展示一张，不打开图库、候选列表或搜索界面。通常先调用 search_stickers 选出最佳匹配，再调用此工具。它展示在 ChatGPT 回复中，不会代替用户发送原生聊天消息。","inputSchema":{"type":"object","properties":{"sticker_id":{"type":"string"}},"required":["sticker_id"]},"_meta":SINGLE_META},
 {"name":"list_sticker_categories","title":"表情分类","description":"列出表情类别和数量。仅在需要分类信息时调用。","inputSchema":{"type":"object","properties":{}},"_meta":WIDGET_META},
 {"name":"open_sticker_library","title":"浏览私人表情图库","description":"仅当用户明确要求查看图库、浏览全部表情或自己挑选时调用。不要在普通聊天或自主选图时调用。","inputSchema":{"type":"object","properties":{}},"_meta":LIBRARY_META}
]

def tool_result(data):
    return {"structuredContent":data,"content":[{"type":"text","text":json.dumps(data,ensure_ascii=False)}]}

def rpc(method,params):
    if method=="initialize":
        return {"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":False},"resources":{}},"serverInfo":{"name":"xlc-stickers","version":"0.2.0"}}
    if method=="ping":return {}
    if method=="tools/list":return {"tools":TOOLS}
    if method=="resources/list":
        return {"resources":[
            {"uri":URI,"name":"私人表情图库（手动浏览）","mimeType":"text/html;profile=mcp-app"},
            {"uri":SINGLE_URI,"name":"单张表情包展示","mimeType":"text/html;profile=mcp-app"}
        ]}
    if method=="resources/read":
        resource_uri=params.get("uri")
        if resource_uri==URI:
            resource_path=ROOT/"picker.html"
        elif resource_uri==SINGLE_URI:
            resource_path=ROOT/"single.html"
        else:
            raise KeyError("Resource not found")
        return {"contents":[{"uri":resource_uri,"mimeType":"text/html;profile=mcp-app","text":resource_path.read_text(),
                 "_meta":{"ui":{"csp":{"resourceDomains":[PUBLIC],"connectDomains":[PUBLIC]}}}}]}
    if method!="tools/call":raise KeyError("Method not found")
    name=params.get("name");args=params.get("arguments") or {}
    if name=="search_stickers":
        results=listing(args.get("query",""),args.get("category",""),args.get("limit",80))
        return tool_result({"stickers":results,"count":len(results)})
    if name=="list_sticker_categories":
        with db() as c:rows=c.execute("SELECT category,count(*) n FROM stickers GROUP BY category").fetchall()
        return tool_result({"categories":[{"category":r["category"],"count":r["n"]} for r in rows]})
    if name=="open_sticker_library":
        return tool_result({"mode":"library"})
    if name=="send_sticker":
        row=get(str(args.get("sticker_id","")))
        if not row:return {"isError":True,"content":[{"type":"text","text":"表情包不存在，请重新搜索。"}]}
        return {"structuredContent":{
                    "id":row["id"],"title":row["title"],"tags":row["tags"].split(),
                    "category":row["category"],"image_url":signed(row,False),"alt":row["title"]},
                "content":[{"type":"text","text":"已选中一张表情包。"}]}
    return {"isError":True,"content":[{"type":"text","text":"未知工具"}]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def common(self):
        self.send_header("Cache-Control","no-store");self.send_header("Referrer-Policy","no-referrer");self.send_header("X-Content-Type-Options","nosniff")
    def respond(self,code,obj):
        raw=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(code);self.send_header("Content-Type","application/json; charset=utf-8");self.common()
        self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
    def body(self):
        n=int(self.headers.get("Content-Length","0"))
        if not 0<n<=12*1024*1024:raise ValueError("请求大小不符合要求")
        return json.loads(self.rfile.read(n))
    def is_admin(self):
        return len(ADMIN_KEY)>=32 and hmac.compare_digest(self.headers.get("X-Admin-Key",""),ADMIN_KEY)
    def is_mcp(self,path):
        return len(MCP_KEY)>=32 and path.startswith("/mcp/") and hmac.compare_digest(path[5:],MCP_KEY)
    def do_GET(self):
        u=urlsplit(self.path)
        if u.path=="/healthz":return self.respond(200,{"ok":True,"ready":len(MCP_KEY)>=32 and len(ADMIN_KEY)>=32,"storage":"ephemeral"})
        if u.path=="/library":
            raw=(ROOT/"library.html").read_bytes()
            self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8");self.common()
            self.send_header("Content-Length",str(len(raw)));self.end_headers();return self.wfile.write(raw)
        if u.path=="/admin/stickers":
            if not self.is_admin():return self.respond(401,{"error":"unauthorized"})
            return self.respond(200,{"stickers":listing(limit=120)})
        m=re.fullmatch(r'/media/([a-f0-9-]{36})/(original|thumb)',u.path)
        if m:
            sid,variant=m.groups();row=get(sid)
            if not row:return self.respond(404,{"error":"not_found"})
            q=parse_qs(u.query)
            try:exp=int(q.get("exp",["0"])[0]);provided=q.get("sig",[""])[0]
            except ValueError:return self.respond(403,{"error":"invalid_token"})
            expected=hmac.new(MCP_KEY.encode(),f'{sid}:{exp}:{variant}'.encode(),hashlib.sha256).hexdigest()
            if not (int(time.time())<=exp<=int(time.time())+960 and hmac.compare_digest(provided,expected)):
                return self.respond(403,{"error":"invalid_or_expired_token"})
            raw=(FILES/(sid+"."+row["ext"])).read_bytes()
            mime=row["mime"]
            if variant=="thumb":
                with Image.open(io.BytesIO(raw)) as im:
                    im.seek(0);pic=im.convert("RGBA");pic.thumbnail((320,320));out=io.BytesIO();pic.save(out,"PNG")
                    raw=out.getvalue();mime="image/png"
            self.send_response(200);self.send_header("Content-Type",mime);self.common()
            self.send_header("Access-Control-Allow-Origin","*");self.send_header("Content-Length",str(len(raw)))
            self.end_headers();return self.wfile.write(raw)
        if u.path.startswith("/mcp/"):
            self.send_response(405);self.send_header("Allow","POST");self.end_headers();return
        return self.respond(404,{"error":"not_found"})
    def do_POST(self):
        u=urlsplit(self.path)
        if self.is_mcp(u.path):
            try:
                r=self.body()
                if r.get("jsonrpc")!="2.0":raise ValueError("Invalid JSON-RPC")
                if "id" not in r:
                    self.send_response(202);self.send_header("Content-Length","0");self.end_headers();return
                try:val=rpc(r.get("method"),r.get("params") or {})
                except KeyError as e:
                    return self.respond(200,{"jsonrpc":"2.0","id":r["id"],"error":{"code":-32601,"message":str(e)}})
                return self.respond(200,{"jsonrpc":"2.0","id":r["id"],"result":val})
            except (ValueError,TypeError,KeyError) as e:return self.respond(400,{"error":"invalid_json_rpc","message":str(e)[:80]})
            except Exception:return self.respond(500,{"error":"internal_error"})
        if u.path.startswith("/mcp/"):return self.respond(401,{"error":"invalid_mcp_path"})
        if u.path=="/admin/upload":
            if not self.is_admin():return self.respond(401,{"error":"unauthorized"})
            try:
                inp=self.body()
                raw=base64.b64decode(inp["data_base64"],validate=True)
                sid=add_image(raw,inp.get("title") or Path(inp.get("filename","表情")).stem,inp.get("tags",""),inp.get("category","默认"))
                return self.respond(200,{"ok":True,"id":sid})
            except Exception as e:return self.respond(400,{"error":"invalid_upload","message":str(e)[:100]})
        if u.path=="/admin/delete":
            if not self.is_admin():return self.respond(401,{"error":"unauthorized"})
            try:
                sid=self.body()["id"];row=get(sid)
                if not row:return self.respond(404,{"error":"not_found"})
                if row["demo"]:return self.respond(403,{"error":"demo_protected"})
                with db() as c:c.execute("DELETE FROM stickers WHERE id=?",(sid,))
                (FILES/(sid+"."+row["ext"])).unlink(missing_ok=True)
                return self.respond(200,{"ok":True})
            except Exception:return self.respond(400,{"error":"invalid_request"})
        return self.respond(404,{"error":"not_found"})

if __name__=="__main__":
    if not (len(MCP_KEY)>=32 and len(ADMIN_KEY)>=32):raise SystemExit("Missing independently generated MCP_PATH_KEY and ADMIN_KEY")
    setup()
    print("Sticker MCP started; storage EPHEMERAL",flush=True)
    ThreadingHTTPServer(("0.0.0.0",int(os.getenv("PORT","10000"))),Handler).serve_forever()
