"""OAuth 2.1 authorization code + PKCE regression tests for owner-only snapshot MCP."""
import base64
import hashlib
import html as htmlmod
import json
import os
import re
import sys
import unittest
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs

os.environ.setdefault("SNAPSHOT_OWNER_SECRET", "test_owner_" + "A"*40)
os.environ.setdefault("SNAPSHOT_MCP_TOKEN", "test_mcp_" + "B"*40)
os.environ.setdefault("SNAPSHOT_SESSION_SECRET", "test_session_" + "C"*40)
sys.path.insert(0,str(Path(__file__).parent))
import oauth

async def request(path, method="GET", data=b"", extra=None):
    sent=[]
    once=False
    async def receive():
        nonlocal once
        if once:
            return {"type":"http.disconnect"}
        once=True
        return {"type":"http.request","body":data,"more_body":False}
    async def send(x):
        sent.append(x)
    hdr=[(b"host",b"xlc-consent-snapshot.onrender.com"),
         (b"origin",oauth.ORIGIN.encode())]
    for k,v in (extra or {}).items():
        hdr.append((k.lower().encode(),v.encode()))
    scope={"type":"http","method":method,"path":path.split("?")[0],
           "query_string":(path.split("?",1)[1] if "?" in path else "").encode(),
           "headers":hdr}
    async def reply(send, response, status_code=200, headers=None, content_type="application/json"):
        b=response if isinstance(response,bytes) else (
          response.encode() if isinstance(response,str) else json.dumps(response).encode())
        await send({"type":"http.response.start","status":status_code,
                    "headers":(headers or [])+[(b"content-type",content_type.encode())]})
        await send({"type":"http.response.body","body":b})
    handled=await oauth.route(scope,receive,send,reply)
    return handled,sent[0]["status"],sent[1]["body"],dict(sent[0]["headers"])


def sync(coro):
    import asyncio
    return asyncio.run(coro)

def post_form(url,fields):
    return sync(request(url,"POST",urlencode(fields).encode(),{"content-type":"application/x-www-form-urlencoded"}))

def register(redirect="https://chatgpt.com/connector_platform_oauth_redirect"):
    raw=json.dumps({"redirect_uris":[redirect],"token_endpoint_auth_method":"none"}).encode()
    _,status,body,_=sync(request("/oauth/register","POST",raw,{"content-type":"application/json"}))
    return status,json.loads(body)

def challenge(verifier):
    return oauth.enc(hashlib.sha256(verifier.encode()).digest())


class OwnerOAuthTests(unittest.TestCase):
    def setUp(self):
        oauth.CODES.clear()
        oauth.ATTEMPTS.clear()

    def test_metadata_and_challenge_header(self):
        _, status, body, _=sync(request("/.well-known/oauth-protected-resource/mcp"))
        self.assertEqual(status,200)
        meta=json.loads(body)
        self.assertEqual(meta["resource"],oauth.RESOURCE)
        self.assertIn(oauth.ORIGIN,meta["authorization_servers"])
        self.assertIn("resource_metadata=",oauth.www_authenticate())

    def test_registration_rejects_unsafe_redirect(self):
        status,data=register("https://attacker.example/redirect")
        self.assertEqual(status,400)
        self.assertEqual(data["error"],"invalid_redirect_uri")

    def test_oauth_login_requires_owner_approval(self):
        code,data=register()
        self.assertEqual(code,201)
        cid=data["client_id"]
        verifier="v"*65
        redirect_uri="https://chatgpt.com/connector_platform_oauth_redirect"
        args={"response_type":"code","client_id":cid,"redirect_uri":redirect_uri,
              "code_challenge":challenge(verifier),"code_challenge_method":"S256",
              "state":"s1"}
        _,status,content,_=sync(request("/oauth/authorize?"+urlencode(args)))
        self.assertEqual(status,200)
        page=content.decode()
        self.assertIn("我同意连接 ChatGPT",page)
        ticket=htmlmod.unescape(re.search(r'name="ticket" value="([^"]+)"',page).group(1))
        _, status, _, _=post_form("/oauth/authorize",{"ticket":ticket,"owner_secret":"wrong"})
        self.assertEqual(status,403)
        _, status, _, headers=post_form("/oauth/authorize",{
            "ticket":ticket,"owner_secret":os.environ["SNAPSHOT_OWNER_SECRET"]})
        self.assertEqual(status,303)
        location=headers[b"location"].decode()
        params=parse_qs(urlsplit(location).query)
        self.assertEqual(params["state"],["s1"])
        issued_code=params["code"][0]
        _,status,body,_=post_form("/oauth/token",{"grant_type":"authorization_code",
            "client_id":cid,"code":issued_code,"redirect_uri":redirect_uri,"code_verifier":verifier})
        self.assertEqual(status,200)
        tokens=json.loads(body)
        self.assertTrue(oauth.authenticated("Bearer "+tokens["access_token"]))
        self.assertFalse(oauth.authenticated("Bearer "+tokens["refresh_token"]))
        self.assertFalse(oauth.authenticated("Bearer garbage"))
        _,status,body,_=post_form("/oauth/token",{"grant_type":"authorization_code",
            "client_id":cid,"code":issued_code,"redirect_uri":redirect_uri,"code_verifier":verifier})
        self.assertEqual(status,400)
        self.assertEqual(json.loads(body)["error"],"invalid_grant")
        _,status,body,_=post_form("/oauth/token",{"grant_type":"refresh_token",
            "client_id":cid,"refresh_token":tokens["refresh_token"]})
        self.assertEqual(status,200)
        self.assertTrue(oauth.authenticated("Bearer "+json.loads(body)["access_token"]))

    def test_invalid_pkce_rejected(self):
        _,reg=register()
        data={"response_type":"code","client_id":reg["client_id"],
              "redirect_uri":"https://chatgpt.com/connector_platform_oauth_redirect",
              "code_challenge":"not-pkce","code_challenge_method":"S256"}
        _,status,_,_=sync(request("/oauth/authorize?"+urlencode(data)))
        self.assertEqual(status,400)


if __name__ == "__main__":
    unittest.main()
