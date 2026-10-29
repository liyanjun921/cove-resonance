import base64, hashlib, hmac, io, json, os, re, sqlite3, time, uuid, zipfile
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from urllib import request as urllib_request, error as urllib_error
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
SINGLE_URI="ui://xlc-stickers/single-v4.html"
MAX=6*1024*1024

def db():
    c=sqlite3.connect(DB,timeout=10)
    c.row_factory=sqlite3.Row
    return c

def setup():
    FILES.mkdir(parents=True,exist_ok=True)
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY,title TEXT,tags TEXT,category TEXT,ext TEXT,mime TEXT,sha TEXT UNIQUE,created INTEGER,demo INTEGER,external_url TEXT)")
        columns={r["name"] for r in c.execute("PRAGMA table_info(stickers)").fetchall()}
        if "external_url" not in columns:
            c.execute("ALTER TABLE stickers ADD COLUMN external_url TEXT")
    seed_catalog()

def seed_catalog():
    path=ROOT/"stickers.json"
    try:
        catalog=json.loads(path.read_text(encoding="utf-8"))
    except (OSError,ValueError):
        return
    allowed_hosts={"pic1.imgdb.cn","raw.githubusercontent.com"}
    now=int(time.time())
    with db() as c:
        for index,item in enumerate(catalog.get("stickers",[])):
            sid=str(item.get("id","")).strip()
            title=str(item.get("name") or item.get("title") or sid).strip()[:65]
            if not sid or not title:
                continue
            url=item.get("image_url")
            if url:
                parsed=urlsplit(str(url))
                if parsed.scheme!="https" or parsed.hostname not in allowed_hosts:
                    url=None
            url=str(url) if url else None
            suffix=Path(urlsplit(url).path).suffix.lower() if url else ".jpg"
            ext=suffix.lstrip(".")
            if ext not in ("png","jpg","jpeg","gif","webp"):
                ext="jpg"
            if ext=="jpeg":
                ext="jpg"
            mime={"png":"image/png","jpg":"image/jpeg","gif":"image/gif","webp":"image/webp"}[ext]
            tags=item.get("tags",[])
            if not isinstance(tags,list):
                tags=[str(tags)]
            tag_text=" ".join(str(t) for t in tags)[:240]
            category=str(item.get("category") or (tags[0] if tags else "默认"))[:36]
            sha=hashlib.sha256((("external:"+url) if url else ("missing:"+sid)).encode()).hexdigest()
            c.execute("""INSERT INTO stickers
                (id,title,tags,category,ext,mime,sha,created,demo,external_url)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,tags=excluded.tags,category=excluded.category,
                ext=excluded.ext,mime=excluded.mime,sha=excluded.sha,
                demo=0,external_url=excluded.external_url""",
                (sid,title,tag_text,category,ext,mime,sha,now-index,0,url))

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
        c.execute("INSERT INTO stickers (id,title,tags,category,ext,mime,sha,created,demo,external_url) VALUES(?,?,?,?,?,?,?,?,?,?)",
          (sid,str(title)[:65],str(tags)[:240],str(category)[:36],ext,mime,sha,int(time.time()),int(demo),None))
        return sid

def import_sticker_zip(raw):
    if len(raw) > 10 * 1024 * 1024:
        raise ValueError("ZIP 不能超过 10MB")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        info={i.filename:i for i in z.infolist() if not i.is_dir()}
        if len(info)>80 or "manifest.json" not in info:
            raise ValueError("ZIP 需要包含 manifest.json，且总文件数不超过 80")
        if info["manifest.json"].file_size>64*1024:
            raise ValueError("清单文件过大")
        manifest=json.loads(z.read("manifest.json").decode("utf-8"))
        items=manifest.get("stickers",[])
        if not isinstance(items,list) or not (1<=len(items)<=50):
            raise ValueError("表情数量必须为 1-50 张")
        total=0
        for item in items:
            if not isinstance(item,dict):
                raise ValueError("表情记录格式不正确")
            name=item.get("file","")
            entry=info.get(name)
            if not isinstance(name,str) or not re.fullmatch(r"images/[A-Za-z0-9_.-]{1,120}\.(?:jpg|jpeg|png|webp|gif)",name,re.I) or not entry:
                raise ValueError("ZIP 清单图片路径不合法")
            if entry.file_size>MAX:
                raise ValueError("单张图片不得超过 6MB")
            total+=entry.file_size
        if total>60*1024*1024:
            raise ValueError("解压总大小超过 60MB")
        output=[]
        for item in items:
            name=item["file"]
            tags=item.get("tags",[])
            if isinstance(tags,list):
                tags=" ".join(str(x) for x in tags)
            sid=add_image(z.read(name),item.get("title") or Path(name).stem,tags,item.get("category") or "默认")
            output.append({"id":sid,"title":str(item.get("title") or Path(name).stem)})
        return {"ok":True,"imported":len(output),"stickers":output}

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
    rows=[r for r in rows if not r["demo"] and (r["external_url"] or (FILES/(r["id"]+"."+r["ext"])).exists())]
    rows=[r for r in rows if (not query or query in (r["title"]+" "+r["tags"]+" "+r["category"]).lower()) and (not category or r["category"]==category)]
    return [{"id":r["id"],"title":r["title"],"tags":r["tags"].split(),"category":r["category"],
       "type":r["mime"],"demo":bool(r["demo"]),"preview_url":signed(r),"image_url":signed(r,False)}
       for r in rows[:max(1,min(int(limit),120))]]

WIDGET_META={"openai/widgetAccessible":True}
LIBRARY_META={"ui":{"resourceUri":URI},"openai/outputTemplate":URI,"openai/widgetAccessible":True}
SINGLE_META={"ui":{"resourceUri":SINGLE_URI},"openai/outputTemplate":SINGLE_URI,"openai/widgetAccessible":True}
TOOLS=[
 {"name":"search_stickers","title":"检索表情包","description":"当聊天情境自然适合表情时（例如想念、撒娇、安慰、开心或晚安），可主动在后台检索并自主挑选一张；每轮最多一张，不要机械地每条消息都发表情，也不必先询问用户。返回候选元数据供 AI 挑选，本工具不会打开或渲染图库。默认流程是先搜索，再调用 send_sticker 展示最匹配的一张。只有用户明确要求浏览/挑选图库时才调用 open_sticker_library。","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"category":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":120}}},"_meta":WIDGET_META},
 {"name":"send_sticker","title":"发送表情包（MCP App 单图）","description":"常规聊天时调用此工具展示一张表情包。它绑定 ChatGPT 内嵌 MCP App 单图界面，读取 structuredContent.image_url 并显示图片；先调用 search_stickers，再用真实 sticker_id 调用本工具。若客户端无法渲染 MCP App，再使用 send_sticker_native 作为备用。不要把工具调用成功等同于用户已经看见图片。","inputSchema":{"type":"object","properties":{"sticker_id":{"type":"string"}},"required":["sticker_id"]},"_meta":SINGLE_META},
 {"name":"send_sticker_native","title":"原生图片备用发送","description":"仅当 MCP App 界面无法在当前客户端显示时使用。直接返回图片数据，不打开 HTML 卡片。常规流程优先使用绑定了 MCP App 的 send_sticker。","inputSchema":{"type":"object","properties":{"sticker_id":{"type":"string"}},"required":["sticker_id"]}},
 {"name":"send_sticker_widget","title":"网页版单图卡片（备用）","description":"仅当用户明确希望测试网页端单图卡片时使用。手机 App 请优先用 send_sticker 或 send_sticker_native。","inputSchema":{"type":"object","properties":{"sticker_id":{"type":"string"}},"required":["sticker_id"]},"_meta":SINGLE_META},
 {"name":"list_sticker_categories","title":"表情分类","description":"列出表情类别和数量。仅在需要分类信息时调用。","inputSchema":{"type":"object","properties":{}},"_meta":WIDGET_META},
 {"name":"open_sticker_library","title":"浏览私人表情图库","description":"仅当用户明确要求查看图库、浏览全部表情或自己挑选时调用。不要在普通聊天或自主选图时调用。","inputSchema":{"type":"object","properties":{}},"_meta":LIBRARY_META}
]

def native_sticker_bytes(row):
    """Make a small, self-contained image for clients that cannot open MCP HTML widgets."""
    if row["external_url"]:
        source_url=row["external_url"]
        parsed=urlsplit(source_url)
        if parsed.scheme!="https" or parsed.hostname not in {"pic1.imgdb.cn","raw.githubusercontent.com"}:
            raise ValueError("图片来源不在允许列表")
        req=urllib_request.Request(source_url,headers={"User-Agent":"Mozilla/5.0 (compatible; XLC-Stickers/1.0)"})
        with urllib_request.urlopen(req,timeout=12) as response:
            final=urlsplit(response.geturl())
            if final.scheme!="https" or final.hostname not in {"pic1.imgdb.cn","raw.githubusercontent.com"}:
                raise ValueError("图片跳转来源不在允许列表")
            raw=response.read(MAX+1)
    else:
        raw=(FILES/(row["id"]+"."+row["ext"])).read_bytes()
    if not raw or len(raw)>MAX:
        raise ValueError("图片文件过大或为空")
    with Image.open(io.BytesIO(raw)) as im:
        if im.width>3000 or im.height>3000:
            raise ValueError("图片像素超过限制")
        im.seek(0)
        pic=im.convert("RGBA")
        pic.thumbnail((360,360),Image.Resampling.LANCZOS)
        out=io.BytesIO()
        pic.save(out,format="PNG",optimize=True)
        rendered=out.getvalue()
        if len(rendered)<=450*1024:
            return rendered,"image/png"
        white=Image.new("RGB",pic.size,"white")
        white.paste(pic,mask=pic.getchannel("A"))
        out=io.BytesIO()
        white.save(out,format="JPEG",quality=88,optimize=True)
        return out.getvalue(),"image/jpeg"

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
                 "_meta":{
                     "ui":{"csp":{"resourceDomains":[PUBLIC,"https://pic1.imgdb.cn","https://raw.githubusercontent.com"],"connectDomains":[PUBLIC]}},
                     "openai/widgetCSP":{"resource_domains":[PUBLIC,"https://pic1.imgdb.cn","https://raw.githubusercontent.com"],"connect_domains":[PUBLIC]}
                 }}]}
    if method!="tools/call":raise KeyError("Method not found")
    name=params.get("name");args=params.get("arguments") or {}
    if name=="search_stickers":
        results=listing(args.get("query",""),args.get("category",""),args.get("limit",80))
        return tool_result({"stickers":results,"count":len(results)})
    if name=="list_sticker_categories":
        with db() as c:rows=c.execute("SELECT category,count(*) n FROM stickers WHERE demo=0 GROUP BY category").fetchall()
        return tool_result({"categories":[{"category":r["category"],"count":r["n"]} for r in rows]})
    if name=="open_sticker_library":
        return tool_result({"mode":"library"})
    if name in ("send_sticker","send_sticker_native","send_sticker_widget"):
        row=get(str(args.get("sticker_id","")))
        if not row or (not row["external_url"] and not (FILES/(row["id"]+"."+row["ext"])).exists()):
            return {"isError":True,"content":[{"type":"text","text":"这张表情包没有可用原图，请重新搜索。"}]}
        data={"id":row["id"],"title":row["title"],"tags":row["tags"].split(),
              "category":row["category"],"image_url":signed(row,False),"alt":row["title"]}
        # The normal send_sticker path renders the embedded MCP App single-image UI.
        if name in ("send_sticker","send_sticker_widget"):
            return {"structuredContent":data,
                    "content":[{"type":"text","text":json.dumps(data,ensure_ascii=False)}]}
        # Native image output remains available as an explicit fallback.
        try:
            picture,mime=native_sticker_bytes(row)
        except (ValueError,OSError,urllib_error.URLError,TimeoutError,UnidentifiedImageError):
            return {"structuredContent":data,
                    "content":[{"type":"text","text":"图片原文件暂时不可读取。可在当前15分钟内打开："+data["image_url"]}]}
        return {"structuredContent":data,
                "content":[
                    {"type":"image","data":base64.b64encode(picture).decode("ascii"),"mimeType":mime},
                    {"type":"text","text":"图片已作为 MCP 原生图像返回。若客户端不显示图片，可使用短期图片链接："+data["image_url"]}
                ]}
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
        if u.path=="/healthz":return self.respond(200,{"ok":True,"ready":len(MCP_KEY)>=32 and len(ADMIN_KEY)>=32,"storage":"GitHub catalog + temporary admin uploads"})
        if u.path=="/library":
            raw=(ROOT/"library.html").read_bytes()
            self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8");self.common()
            self.send_header("Content-Length",str(len(raw)));self.end_headers();return self.wfile.write(raw)
        if u.path=="/admin/stickers":
            if not self.is_admin():return self.respond(401,{"error":"unauthorized"})
            return self.respond(200,{"stickers":listing(limit=120)})
        m=re.fullmatch(r'/media/([A-Za-z0-9_-]{1,80})/(original|thumb)',u.path)
        if m:
            sid,variant=m.groups();row=get(sid)
            if not row:return self.respond(404,{"error":"not_found"})
            q=parse_qs(u.query)
            try:exp=int(q.get("exp",["0"])[0]);provided=q.get("sig",[""])[0]
            except ValueError:return self.respond(403,{"error":"invalid_token"})
            expected=hmac.new(MCP_KEY.encode(),f'{sid}:{exp}:{variant}'.encode(),hashlib.sha256).hexdigest()
            if not (int(time.time())<=exp<=int(time.time())+960 and hmac.compare_digest(provided,expected)):
                return self.respond(403,{"error":"invalid_or_expired_token"})
            if row["external_url"]:
                try:
                    source_url=urlsplit(row["external_url"])
                    if source_url.scheme!="https" or source_url.hostname not in {"pic1.imgdb.cn","raw.githubusercontent.com"}:
                        return self.respond(502,{"error":"upstream_host_not_allowed"})
                    request=urllib_request.Request(row["external_url"],headers={"User-Agent":"Mozilla/5.0 (compatible; XLC-Stickers/1.0)"})
                    with urllib_request.urlopen(request,timeout=10) as response:
                        final_url=urlsplit(response.geturl())
                        if final_url.scheme!="https" or final_url.hostname not in {"pic1.imgdb.cn","raw.githubusercontent.com"}:
                            return self.respond(502,{"error":"upstream_redirect_not_allowed"})
                        raw=response.read(MAX+1)
                        upstream_mime=response.headers.get_content_type()
                    if len(raw)>MAX:
                        return self.respond(413,{"error":"upstream_image_too_large"})
                    mime=upstream_mime if upstream_mime.startswith("image/") else row["mime"]
                except (urllib_error.URLError,TimeoutError,OSError,ValueError):
                    return self.respond(502,{"error":"upstream_image_unavailable"})
            else:
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
        if u.path=="/admin/import-zip":
            if not self.is_admin():return self.respond(401,{"error":"unauthorized"})
            try:
                inp=self.body()
                raw=base64.b64decode(inp["data_base64"],validate=True)
                result=import_sticker_zip(raw)
                return self.respond(200,result)
            except (ValueError,KeyError,TypeError,zipfile.BadZipFile,UnicodeError,json.JSONDecodeError) as e:
                return self.respond(400,{"error":"invalid_zip","message":str(e)[:120]})
            except Exception:
                return self.respond(500,{"error":"import_failed"})
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
