# muse.ai ("hatch") wire protocol — byte-level reference

Extracted 2026-11-03 by reading the real source of the reverse-engineering repos below.
Citations are `repo:file:line`. Every value is copied from code, never inferred — unless the
line says `INVENTED` / `NOT FOUND` / `DISCREPANCY`.

## Sources actually used

| tag | repo | branch | commit | verdict |
|---|---|---|---|---|
| `ben` | `its-benjamin/muse2api-http` | `master` | `6309f64b44ce133a2428fadf966a395d503ce84f` | **THE useful one.** Full browserless Noise+protobuf client. |
| `minh` | `minhquan130599/MuseAI-API` | `main` | `bf964f7c022f11a3574e2e17a8ec57e7c9b0e596` | The repo `ben` credits as the origin of its Noise/wire codec (`ben:README.md:25-32`). Independent cross-check. **Caveat: every `.py` file in `minh` literally contains `"  N \| "` line-number prefixes + CRLF, so it is a line-numbered dump, not runnable source.** All `minh:file:line` cites refer to the *embedded* number, which equals the real file line. |
| `www` | `www222fff/muse2api` | `main` | `3a20b5e7aa4056c99c0eb8c732d73ce3804d5dbf` | **No Noise/protobuf at all.** DOM/CDP driver only. Useful for cookie/wake facts (§E). |
| `czg` | `czg86389-hub/muse2api` | `main` | `58c1e7c01355ca8c10076725143d5a8ca3ceba06` | **No Noise/protobuf** (`grep -i noise engine.py app.py cdp.py` → zero hits). CDP/Playwright only. Useful for cookie TTLs (§E). |

Confirmed: `ben`'s `protocol.json` was machine-extracted from the public muse.ai Next.js
bundle via regex on `HATCH_SHARED_LB_HOST` / `NOISE_WS_PATH` / `HATCH_APP_ID`
(`ben:muse2api/discover.py:172-174`). It is bundle-derived data, not hand-guesses.

---

# A. NOISE HANDSHAKE

### A1. Protocol name string
`"Noise_XX_25519_AESGCM_SHA256"` — used verbatim as the protocol name, **no prologue**.

- `ben:muse2api/noise.py:20` → `PROTOCOL = b"Noise_XX_25519_AESGCM_SHA256"`
- `minh:muse_ai/noise.py:16` → identical.
- InitializeSymmetric: `name.ljust(32, b"\x00")` assigned to **both** `h` and `ck`, then one
  explicit `mix_hash(b"")`. `ben:muse2api/noise.py:92-98`, `minh:muse_ai/noise.py:76-92`.
  (`minh` adds the `len(NAME) <= 32` guard explicitly; the 27-byte name pads to 32.)
- HKDF is standard Noise (2 or 3 output), SHA-256: `ben:muse2api/noise.py:28-37`.
- `MixHash(d) = h = SHA256(h || d)`; `EncryptAndHash` uses `h` as AES-GCM AAD, then
  `MixHash(ciphertext)` — `ben:muse2api/noise.py:107-115`.

### A2. Known / preset remote static key
**NONE. There is no pinned server static key anywhere in any of the four repos.**
The server's static key `rs` is *learned* from Noise msg2 (decrypted `msg[32:80]`) and is
**not** compared to any constant:

- `ben:muse2api/noise.py:158` → `self.remote_static = self.symmetric.decrypt_and_hash(message[32:80])`
- `minh:muse_ai/noise.py:159` → `self.rs = self.symmetric.decrypt_and_hash(msg[offset:offset + 48])`
- It is only ever surfaced as a property `remote_static_public_key`
  (`ben:muse2api/noise.py:186-188`) and passed to an **optional external attestation binary**
  for confidential-VM accounts: `ben:muse2api/gateway.py:361-368` →
  `run_attestation_verifier(..., server_static_key=noise.remote_static_public_key or b"", ...)`,
  which base64s it into a JSON stdin blob (`ben:muse2api/cvm.py:208-215`). Standard
  (`vm_type: "hatch_vm"`) accounts never enter this path
  (`ben:README.md:336-344`, `ben:muse2api/gateway.py:349-353`).
- No URL that serves an expected public key was found → **NOT FOUND**.

Consequence for your client: XX gives you *no* server authentication unless you verify the
attestation blob in msg2 yourself. `ben`/`minh` both **decrypt msg2 and do not verify it**
(`minh:muse_ai/transport.py:140-143`: "Full SNP attestation verification is intentionally a
separate hardening step"; `ben:README.md:322-357` "fail closed" only for the CVM branch).

### A3. Handshake message sizes / payloads

| msg | exact bytes | where |
|---|---|---|
| msg1 | **66 bytes** = `e_pub(32)` ‖ **cleartext** `0a 20 <nonce32>` | `ben:muse2api/noise.py:140-148`, `ben:muse2api/noise.py:191-199` |
| msg2 | **≥ 96 bytes** = `re(32)` ‖ `Enc(rs)`(48) ‖ `Enc(payload)`. `len(payload)==0` ⇒ exactly 96. Standard VMs send a **non-empty** payload = attestation blob. | `ben:muse2api/noise.py:150-164`, `ben:muse2api/gateway.py:348-352` |
| msg3 | **48 bytes** = `Enc(s_pub)`(32+16 tag) ‖ `Enc(b"")`(16 tag) when payload empty | `ben:muse2api/noise.py:166-174`, `minh:muse_ai/transport.py:144` |

- **msg1 DOES carry bytes** and they are **NOT encrypted** (at msg1 the cipher state still has
  no key, so `encrypt_and_hash` is a passthrough — `ben:muse2api/noise.py:71-76`,
  `minh:muse_ai/noise.py:61-66`). The payload is protobuf `field 1 = bytes` holding 32 random
  bytes = client nonce: literally `b"\x0a\x20" + nonce` (`ben:muse2api/noise.py:191-199`,
  `minh:muse_ai/noise.py:194-198`, comment there: *"protobuf field 1, bytes: tag 0x0a followed
  by 32-byte length"*).
  The nonce is generated `os.urandom(32)` and is **discarded** by both clients for standard VMs
  (`ben:muse2api/gateway.py:336`, `minh:muse_ai/transport.py:134`) — it only matters for CVM.
- **msg2 payload**: parsed strictly as the RV challenge shape; anything else = "standard message
  2 payload". `ben:muse2api/gateway.py:348-353`. RV challenge fields
  (`ben:muse2api/cvm.py:67-113`): `1: attestation bytes`, `2: state varint` (1=UNPROVISIONED,
  2=PROVISIONED), `3: vm_nonce bytes(32)`, `4: vm_proof bytes(32)`, `5: chip_binding bytes`.
  A valid challenge **requires** field 1 and field 3(32B) — otherwise `decode_challenge`
  returns `None` and it is treated as an opaque attestation blob
  (`ben:muse2api/cvm.py:104-113`). Constants: `ben:muse2api/cvm.py:32-33`.
- **msg3 payload**: `b""` for standard VMs (`minh:muse_ai/transport.py:144`
  `await ws.send(noise.write_message3(b""))`). For CVM only,
  `encode_message3` = `field1 = notary_token string`, `field2 = payload bytes` where the field-2
  **tag is `18` (0x12, fresh/RV key) or `26` (0x1a, recovery/HMAC proof)** —
  literal: `ben:muse2api/cvm.py:164-173`. CVM domains: `ben:muse2api/cvm.py:26-30`.

### A4. XK / IK fallback?
**NO. Not present in any repo.** `grep -rn "Noise_XK\|Noise_IK\|Noise_NN"` across all four
repos → only `Noise_XX_25519_AESGCM_SHA256`. The only handshake variant is the CVM msg2/msg3
payload difference *inside* XX (§A3). Standard accounts: plain XX, nothing else.

### A5. Framing of handshake over the WebSocket
**Raw Noise bytes. Exactly one WS *binary* frame per Noise message. No protobuf, no JSON, no
length prefix, no wrapping, no magic.**

```
ben:muse2api/gateway.py:337   await ws.send(noise.write_message1(payload1))
ben:muse2api/gateway.py:341   message2 = await asyncio.wait_for(ws.recv(), timeout)
ben:muse2api/gateway.py:378   await ws.send(noise.write_message3(message3_payload))
ben:muse2api/gateway.py:344-346  must be bytes/bytearray else "expected binary Noise handshake message 2"
minh:muse_ai/transport.py:135-144 identical with the stdlib `websockets` client
```

Initiator-first confirmed by the source (client `send`s msg1 before ever calling `recv`).
Note `ben:muse2api/gateway.py:342-343`: the `curl_cffi` WS client returns `(payload, flags)`
tuples — a stdlib/Node client just gets the buffer.

### A6. After `split()` — nonce + transport frame layout

**Nonce:** 12 bytes = `00 00 00 00` (4-byte zero prefix) ‖ **8-byte BIG-ENDIAN** counter,
starting at 0 and incremented per message, **per direction**:

```
ben:muse2api/noise.py:40-43   return b"\x00" * 4 + counter.to_bytes(8, "big")
minh:muse_ai/noise.py:36-39   identical
minh:tests/test_core.py:23-25 test_noise_nonce_big_endian: nonce12(1) == b"\x00"*11 + b"\x01"
ben:muse2api/noise.py:117-120 split(): ck1 -> tx, ck2 -> rx; both counters reset to 0
```

**Frame = AES-GCM(plaintext, ad=b"") output = `ciphertext ‖ 16-byte tag` — the tag is
APPENDED, not separated. There is NO `[2-byte length]` and NO `[u32 len]` prefix.** The
WebSocket binary frame boundary *is* the length. AAD is the empty string:

```
ben:muse2api/gateway.py:453   await self.ws.send(self.tx.encrypt_with_ad(EMPTY_AD, frame))
ben:muse2api/gateway.py:409   plaintext = self.rx.decrypt_with_ad(EMPTY_AD, bytes(message))
ben:muse2api/noise.py:21      EMPTY_AD = b""
minh:muse_ai/transport.py:84-96 identical
```

(Not `MAX_MESSAGE_SIZE`-limited: `max_size=None` / `max_message_size=16*1024*1024`,
`ben:muse2api/gateway.py:282`, `minh:muse_ai/transport.py:128`.)

**Inside every transport frame is one protobuf `NoiseTransportFrame`** — this is the length
mechanism (§B). Reassembly: `ben:muse2api/gateway.py:409-414` =
`decrypt -> NoiseReassembler.feed -> decode_service_response -> decode_service_frame`.

### A7. Keepalive / ping over the Noise channel
**There is NO application-level keepalive sent over the Noise channel.** Specifically:

- No periodic `/api/ping`. It is only invoked once, by the `muse2api ping` CLI:
  `ben:muse2api/__main__.py:39`, `minh:muse_ai/cli.py:74-77`.
- The only ping is the **WebSocket protocol-level** ping, and only on the stdlib fallback
  path: `ben:muse2api/gateway.py:325-326` → `ping_interval=20, ping_timeout=20`;
  `minh:muse_ai/transport.py:130-131` → same. The primary `curl_cffi` path
  (`ben:muse2api/gateway.py:277-285`) sets **no** ping.
- Housekeeping is HTTP-side only: a 60 s loop doing curl_cffi HTTP/2 `upkeep()` plus cookie
  renewal every 7200 s (`MUSE_COOKIE_RENEW_SECONDS`, default `7200`) and full refresh at
  30 min — `ben:muse2api/server.py:698-754`, `ben:muse2api/config.py:50,105`.
- Idle sleep after `MUSE_IDLE_SLEEP_SECONDS` (default 1800) closes upstream conns
  (`ben:muse2api/config.py:99`, `ben:README.md:309-314`).
- The client **does** send a `Reset` frame when it stops reading a stream early
  (`ben:muse2api/gateway.py:467-483`, `_send_reset(stream_id, 1, reason)`), which is
  flow control, not keepalive.

---

# B. PROTOBUF FRAMING

### B1. Message shapes (field numbers)
**There is no `.proto` file in any of the four repos** (`find -name "*.proto"` → empty).
The field numbers exist only as the hand-written encoder/decoder plus this docstring, which
is the closest thing to a schema and is reproduced verbatim
(`ben:muse2api/wire.py:1-20`, described there as "from the web bundle descriptors"):

```proto
NoiseTransportFrame { int64 chunk_id=1; uint32 chunk_index=2;
                      uint32 total_chunks=3; bytes payload=4; }
ServiceRequest  { ServiceType service=1; bytes payload=2; }
ServiceResponse { bytes payload=1; }
ServiceFrame    { int64 stream_id=1;
                  oneof kind { ApplicationRequest request=2;
                               ApplicationResponse response=3;
                               BodyChunk body_chunk=4; Reset reset=5; } }
ApplicationRequest  { string verb=1; string path=2; repeated Header headers=3;
                      bytes body=4; bool end_body=5; }
ApplicationResponse { int32 status=1; repeated Header headers=2;
                      bytes body=3; bool end_body=4; }
BodyChunk { bytes data=1; bool end_body=2; }
Header    { string key=1; string value=2; }
Reset     { Code code=1; string reason=2; }
```

Independently confirmed by the hand-written encoders — do **not** treat these as guesses:

| shape | encode site | decode site |
|---|---|---|
| `NoiseTransportFrame` | `ben:muse2api/wire.py:272-278` | `ben:muse2api/wire.py:280-295` |
| `ServiceRequest` | `ben:muse2api/wire.py:254-255` | — |
| `ServiceResponse` | — | `ben:muse2api/wire.py:258-262` (field 1, wire 2 only) |
| `ServiceFrame`(request) | `ben:muse2api/wire.py:191-192` | `ben:muse2api/wire.py:213-214` → `kind="request"` |
| `ServiceFrame`(response) | — | `ben:muse2api/wire.py:215-217` → `kind="response"` |
| `ServiceFrame`(body_chunk) | `ben:muse2api/wire.py:195-197` | `ben:muse2api/wire.py:218-227` |
| `ServiceFrame`(reset) | `ben:muse2api/wire.py:200-202` | `ben:muse2api/wire.py:228-237` |
| `ApplicationRequest` | `ben:muse2api/wire.py:141-150` | — (client never parses requests) |
| `ApplicationResponse` | — | `ben:muse2api/wire.py:160-181` |
| `Header` | `ben:muse2api/wire.py:129-130` | `ben:muse2api/wire.py:169-176` |

`minh:muse_ai/wire.py:103-227` is the same codec, minus `ApplicationRequest` decoding and
minus the `field 2 = request` branch in `decode_service_frame`
(`minh:muse_ai/wire.py:179-209` only handles 3/4/5).

`ServiceType` enum (`ben:muse2api/wire.py:241-251`, `minh:muse_ai/wire.py:212-215`):
```
daemon = 0   sentinel = 1   vault = 2   authd = 3
```
A 5th service, `ssh_access`, is referenced only as a raw string in the route table
(`ben:muse2api/protocol.json` → `ssh.operator.enable`, `svc=ssh_access`); **its numeric value
is NOT FOUND** — `ben:muse2api/wire.py:241-251` does not define it and `ben`'s `SERVICES`
dict would `KeyError` on it.

### B2. RPC dispatch
The method is **not** a protobuf field. It is HTTP-over-Noise: the `method`/verb string goes in
`ApplicationRequest.verb` (field 1, wire 2), the RPC name goes in
`ApplicationRequest.path` (field 2, wire 2), the JSON body in `body` (field 4, bytes),
headers in `headers` (field 3, repeated `Header`). Request demux is
`ServiceFrame.stream_id` (field 1, **int64**).

```
ben:muse2api/gateway.py:443-455  request = ApplicationRequest(method, path, headers, body, True)
                                 service_frame = encode_service_frame_request(stream_id, request)
                                 envelope    = encode_service_request(SERVICES[service], service_frame)
                                 for frame in split_noise_payload(envelope):
                                     ws.send(tx.encrypt_with_ad(EMPTY_AD, frame))
```

- **GET**: query string is folded into `path` and `body` is `b""`
  (`ben:muse2api/gateway.py:496-500`, `minh:muse_ai/transport.py:222-226`).
- **non-GET**: `body = json.dumps(params, ensure_ascii=False, separators=(",",":")).encode()`
  and `Content-Type: application/json` is added
  (`ben:muse2api/gateway.py:502-504`, `minh:muse_ai/transport.py:227-230`).
- Headers emitted on **every** request (`ben:muse2api/gateway.py:433-441`):
  `Content-Type: application/json` (POST/PUT/PATCH only, inserted at index 0),
  `x-request-id: <uuid4>`, `x-app-id: hatch-web`, `Accept-Language: <locale, default en-US>`.
  `minh:muse_ai/transport.py:148-166` uses the identical set/order
  (Content-Type first, then x-request-id, x-app-id, Accept-Language) plus an `extra` list.
- `stream_id` allocation: client-side, starts at **1**, `+=1` per request
  (`ben:muse2api/gateway.py:229,457-461`; `minh:muse_ai/transport.py:67,79-80`).

### B3. Exact encoder byte layout
Standard proto3, **no zigzag anywhere** (`sint*` never used; negatives are 10-byte
two's-complement varints).

```
tag            = varint((field_no << 3) | wire_type)      ben:muse2api/wire.py:53-54
varint         = 7 LE groups, low group first, 0x80 = continue   ben:muse2api/wire.py:39-50
negative int64 = value &= (1<<64)-1  then varint            ben:muse2api/wire.py:40-41
f_varint(f,v)  = tag(f,0) + varint(v)                       ben:muse2api/wire.py:57-58
f_bytes(f,b)   = tag(f,2) + varint(len(b)) + b              ben:muse2api/wire.py:61-62
f_string       = f_bytes(f, utf8)                           ben:muse2api/wire.py:65-66
f_bool(f,v)    = tag(f,0) + varint(1 or 0)                  ben:muse2api/wire.py:69-70
```

Decoding also accepts fixed64 (`wire_type 1`) and fixed32 (`wire_type 5`) and raises on
`3/4/6/7` (`ben:muse2api/wire.py:104-117`). `int64` fields read via `signed64()`
= `v - 2**64 if v & 2**63` (`ben:muse2api/wire.py:120-121`).

**Emit ordering rules that matter for byte-reproduction:**
- `f_bool(5, end_body)` is **always** emitted on `ApplicationRequest`, even when `False`
  (→ trailing `28 00`); `body` (field 4) is **omitted entirely when empty**
  (`ben:muse2api/wire.py:147-149`).
- `encode_service_request` writes `key(1,0)+varint(service)` — so `service=0` (daemon) still
  emits the tag and `0x00` (`ben:muse2api/wire.py:254-255`). Do **not** skip it.
- `NoiseChunk` always emits fields 1,2,3, then 4 (`ben:muse2api/wire.py:272-278`).
- `chunk_id` = **random signed int64** from `struct.unpack("<q", os.urandom(8))[0]`
  (**little-endian** unpack, then varint'd as unsigned 64) — `ben:muse2api/wire.py:298-299`.
- Empty envelope is not possible: `split_noise_payload(b"")` still yields one chunk with
  `total=1, index=0, payload=b""` (`ben:muse2api/wire.py:307-308`).

### B4. Chunking — DISCREPANCY (resolve before you ship)
Two different outbound split sizes:

| value | site | note |
|---|---|---|
| `65_489` | `minh:muse_ai/wire.py:13` | `MAX_NOISE_CHUNK_PAYLOAD`. `65536 - 47`. Almost certainly the real browser value. |
| `4 * 1024 * 1024` | `ben:muse2api/wire.py:34` | used as the **default** of `split_noise_payload`, so `ben` effectively **never** splits outbound. Its own comment on line 29-33 says *"Outgoing payloads are split at 48 KiB"* — the comment is stale relative to the constant. |
| `48 * 1024` | `ben:tests/test_wire_noise.py:15` | passed explicitly in the round-trip test. |

Shared limits, both repos: `MAX_NOISE_CHUNKS = 256`, `MAX_ASSEMBLY_BYTES = 16 MiB`
(`ben:muse2api/wire.py:35-36`, `minh:muse_ai/wire.py:14-15`). `ben` deliberately allows a
**larger inbound single chunk** than the outbound split, because "the gateway itself sends
large messages (approval snapshots with presentation/traces, permission listings) as single
chunks" — `ben:muse2api/wire.py:29-33`, `ben:tests/test_wire_noise.py:24-28`.
`minh` *rejects* inbound payloads `> 65_489` (`minh:muse_ai/wire.py:294-295`) while `ben`
rejects only `> 4 MiB` (`ben:muse2api/wire.py:330-332`).
**Recommendation for you: split outbound at 65489, accept inbound chunks up to ~4 MiB,
cap assembly at 16 MiB, cap reassembly map at 32 pending `chunk_id`s with oldest-first
eviction (`ben:muse2api/wire.py:333-334`).**

### B5. Response body framing = NDJSON
`ApplicationResponse.body` / `BodyChunk.data` concatenate into a **newline-delimited JSON**
stream — one JSON object per line, sometimes with **no** trailing newline on the last one:

```
minh:muse_ai/transport.py:339-348   while b"\n" in buffer: partition, json.loads(line)
                                    on end_body: if buffer.strip(): yield json.loads(buffer)
ben:muse2api/gateway.py:183-206     same, plus an incremental UTF-8 decoder and a
                                    "tail starts with { or [ -> try parse now" heuristic
```

Binary responses (`/fs/raw/...`, `/media/raw/...`) are the exception: `response.body` is used
as raw bytes, not parsed (`ben:muse2api/media.py:281-284`).

---

# C. RPC DETAILS

Route table source of truth: `ben:muse2api/protocol.json` (**352 routes**, bundle-extracted,
`ben:muse2api/discover.py:109-185`) with hand-coded defaults in `ben:muse2api/protocol.py:50-59`
and `minh:muse_ai/routes.py:15-37`. `service` defaults to `daemon` when the key is absent
(`ben:muse2api/protocol.py:45`).

### C1. `POST /api/ping` — your first live gate
- Route: `connection.ping` → `POST /api/ping`, `service=daemon`
  (`ben:muse2api/protocol.py:51`, `ben:muse2api/protocol.json` → `routes["connection.ping"]`,
  `minh:muse_ai/routes.py:16`).
- **Request body: `{}`** — the literal two bytes `7b 7d`. Both repos pass an empty dict, which
  `request()` JSON-encodes rather than leaving empty: `ben:muse2api/__main__.py:39`
  `conn.request("POST", protocol.route("connection.ping").path, {})`;
  `minh:muse_ai/client.py:86-87` `self._conn().request("POST", "/api/ping", {})`.
  Because it's non-GET, `Content-Type: application/json` is set (`ben:muse2api/gateway.py:503-504`).
- Build recipe (layers inside-out): `ApplicationRequest` → `ServiceFrame(stream_id)` →
  `ServiceRequest(service=daemon)` → `NoiseTransportFrame` → `AESGCM(tx_key, nonce=0, ad=b"")`.
  **Verified worked example**, actually run against the encoder logic above with `stream_id=1`,
  `chunk_id=5`, `x-request-id=00000000-0000-4000-8000-000000000001`:

  ```
  ApplicationRequest                      = 0a04504f5354 12092f6170692f70696e67
    1a20 0a0c "Content-Type" 1210 "application/json"
    1a34 0a0c "x-request-id" 1224 "00000000-0000-4000-8000-000000000001"
    1a15 0a08 "x-app-id"     1209 "hatch-web"
    1a18 0a0f "Accept-Language" 1205 "en-US"
    2202 7b7d  2801                       # body="{}" , end_body=true
    -> 0a04504f535412092f6170692f70696e671a200a0c436f6e74656e742d5479706512106170706c69636174696f6e2f6a736f6e1a340a0c782d726571756573742d6964122430303030303030302d303030302d343030302d383030302d3030303030303030303030311a150a08782d6170702d6964120968617463682d7765621a180a0f4163636570742d4c616e67756167651205656e2d555322027b7d2801
  ServiceFrame   = 0801 12a001 <ApplicationRequest>
  ServiceRequest = 0800 12a501 <ServiceFrame>              # 170 bytes total
  NoiseTransportFrame (THE NOISE PLAINTEXT OF FRAME 1):
  08051000180122aa01080012a501080112a0010a04504f535412092f6170692f70696e671a200a0c436f6e74656e742d5479706512106170706c69636174696f6e2f6a736f6e1a340a0c782d726571756573742d6964122430303030303030302d303030302d343030302d383030302d3030303030303030303030311a150a08782d6170702d6964120968617463682d7765621a180a0f4163636570742d4c616e67756167651205656e2d555322027b7d2801
  WS binary frame = AESGCM(tx_key, nonce=000000000000000000000000, ad=b"", pt=above)
                  = ciphertext || 16-byte tag  -> 195 bytes on the wire
  ```
  Note `22aa01` / `12a501` / `12a001`: lengths ≥ 128 use **two-varint-byte** length prefixes —
  don't hardcode single bytes. `chunk_id=5` is only for this example; the real value is random.
- **Response shape: NOT FOUND.** Neither repo decodes it. `ben` prints
  `f"ping: HTTP {response.status} {response.text()[:200]}"`
  (`ben:muse2api/__main__.py:40`) and `minh` prints `HTTP {status}` then `response.text()`
  (`minh:muse_ai/cli.py:75-77`) — i.e. they gate purely on `ApplicationResponse.status < 400`
  (`raise_for_status`, `ben:muse2api/gateway.py:134-141`). Treat "status 200 + any JSON" as
  success. The generic gateway envelope for other daemon RPCs is `{"ok": true, "result": {...}}`
  (`ben:muse2api/approvals.py:424`) — **plausible but not verified for ping; do not rely on it.**
- Cheaper alternative gate used by the CLI: `GET /model` (`model.get`,
  `ben:muse2api/__main__.py:41`) and `GET /api/session/list` (returns `{"sessions": [...]}`,
  `ben:muse2api/__main__.py:43-46`).

### C2. `POST /chat/stream`
Route: `chat.stream` → `POST /chat/stream`, `service=daemon`
(`ben:muse2api/protocol.py:56` sets `streamMode:"subscription"`).

**Two different bodies are in use — both work:**

(a) side-chat/thread mode, the richer one (`ben:muse2api/chat.py:411-419`):
```json
{
  "items":        [{"type": "text", "text": "<prompt>"}],
  "message":      "<prompt>",
  "node_id":      "<uuid4 — stable per session, client-generated>",
  "capabilities": ["chat_cancel","delta_stream","custom_reactions",
                   "custom_reactions_facebook_thumbs_up_v1"],
  "session_id":   "<uuid4 — client-generated, becomes the muse side-chat id>",
  "timezone":     "UTC",
  "metadata":     {"thread_is_dictation_used": false}
}
```
(b) minimal form (`minh:muse_ai/client.py:121-127`) — **no `message`, no `timezone`, no
`metadata`**, `session_id` only when continuing a thread:
```json
{"items": [...], "node_id": "<device uuid4>", "capabilities": [...], "session_id": "<optional>"}
```
(c) `main`-chat form omits `session_id` (`ben:muse2api/chat.py:677-687`).

- `items[]` element shapes — text: `{"type":"text","text":<str>}`
  (`ben:muse2api/chat.py:412`, `minh:muse_ai/attachments.py:84`); image:
  `{"type":"image","mime_type":<str>,"data_base64":<str>,"filename":<str>}`
  (`minh:muse_ai/attachments.py:74-79`). Images are **inlined base64**, and `minh` resizes to
  max-dimension 2048 / target ≤3.5 MB (JPEG q90→55 step 8, or WebP q88 if alpha) precisely to
  stay inside "Noise's ~16 MiB assembly budget" (`minh:muse_ai/attachments.py:25-66`).
- `CAPABILITIES` list literal: `ben:muse2api/chat.py:36-41` ≡ `minh:muse_ai/routes.py:40-45`
  (identical 4 strings). Sent **both** in `/chat/stream` and `/chat/subscribe`.
- `node_id`: a **client-generated uuid4**, persisted in `<state>/device.json`
  (`minh:muse_ai/client.py:70-83`) or in `chat_sessions.json` per session key
  (`ben:muse2api/chat.py:165,225`). Not issued by the server.
- `session_id`: also client-generated `str(uuid.uuid4())` — `ben:muse2api/chat.py:225`
  creates the pair `(session_id, node_id)` locally. You do **not** need `/api/session/list`
  first; a brand-new uuid works and the server adopts it.
- Sent as a **stream**, and the ack is optional: `ben:muse2api/chat.py:422-427` calls
  `conn.ack("POST", "/chat/stream", body, timeout=20.0)` and on `TimeoutError`/`GatewayError`
  logs "ack unavailable … falling back to history search". `minh` wraps the whole subscribe in
  `asyncio.timeout(30)` and **catches TimeoutError deliberately**, commenting
  *"chat.stream is an acknowledgement/subscription endpoint. Some server revisions leave it
  open longer than the generation itself"* (`minh:muse_ai/client.py:130-143`).
  **=> Do NOT treat a still-open /chat/stream as an error; and do NOT wait on it for the answer.**
- Ack record: `ack.get("message_id") or ack.get("id")` — the **user** message id
  (`ben:muse2api/chat.py:423-425`).

**Streamed event shape.** Every record is one JSON object with:
`event` **or** `event_name` (string), `payload` (object), `ts_ms` (epoch **milliseconds**),
`message_id`, `reply_to_message_id`, `resources`, and a nested
`payload.transcript.messages[].content[]`.

Event type names actually handled in code (all of them, complete):

| name | where consumed | payload fields |
|---|---|---|
| `message.user` | `ben:muse2api/chat.py:531-535` | `display_text` / `text` |
| `message.assistant` | `ben:muse2api/chat.py:546-557`, `:723-730` | `display_text` / `text`, `payload.display_text`/`text`/`content`/`delta`, `message_id`, `reply_to_message_id` |
| `delta.text_append` | `ben:muse2api/chat.py:706-711` | `payload.text` **or** `payload.delta` |
| `delta.message_done` | `ben:muse2api/chat.py:712-722` | terminal; fallback text at `payload.transcript.messages[].content[]` where `content.type=="text"` → `content.text` |
| `delta.presentation` | `ben:muse2api/media.py:151`, `ben:tests/test_main_mode.py:26` | `payload.kind` ∈ {`image`,`video`}, `payload.data.images[]`, `payload.data.videos[]` |

- Text-field read order, exactly as coded
  (`ben:muse2api/chat.py:276-287`): `event.display_text` → `event.text` →
  `event.payload.display_text` → `event.payload.text` → `event.payload.content` →
  `event.payload.delta`. And `_as_text` (`ben:muse2api/chat.py:256-273`) accepts a bare string,
  a **list** of `{text:<str>}` joined with `""`, or a dict recursing on `text`/`display_text`/`content`.
- **Terminal / done event:** `delta.message_done` (stream mode, `ben:muse2api/chat.py:712`) or
  `message.assistant` (`ben:muse2api/chat.py:723-730`). Also `ServiceFrame.Reset` (field 5)
  terminates (`ben:muse2api/gateway.py:176-178`), as does `end_body=true` on a
  `BodyChunk`/`ApplicationResponse` (`ben:muse2api/gateway.py:166-175`).
- **Delta accumulation:** deltas are true increments — `parts.append(text)` then `"".join(parts)`
  (`ben:muse2api/chat.py:709,731`). In thread mode (history polling) the text is a
  *snapshot*, so they diff by length and emit `current_text[emitted:]`
  (`ben:muse2api/chat.py:565-569`).
- Timestamp filtering: drop any event whose `ts_ms < int(time.time()*1000)` captured just
  before sending (`ben:muse2api/chat.py:676, 701-702`).
- There is **also** `POST /chat/stream-events` (`chat.stream_events`, `ben:muse2api/protocol.json`,
  `minh:muse_ai/routes.py:20`, `subscription=True`) and `GET /chat/history-window`
  (`chat.history_window`). **Neither is called by any code path** → their payloads are
  **NOT FOUND**.

### C3. `GET /chat/history`
- Route `chat.history` → `GET /chat/history` (`ben:muse2api/protocol.py:58`).
- Query params (folded into `path`, §B2): `limit`, `session_id`, and optionally
  `transcript_mode`. `ben:muse2api/chat.py:499-504` uses `{"limit": 60, "session_id": sid}`.
  `minh:muse_ai/client.py:102-109` uses `{"limit": limit(40 default, 80 for polling),
  "transcript_mode": "messages", "session_id": sid}` — `session_id` **omitted entirely** if
  falsy (`:107-108`).
- **Response:** `{ "chat_events": [...] }` — and the reader tries
  `result` unwrap first, then keys `chat_events`, `events`, `history` in that order:
  `ben:muse2api/chat.py:290-300` → `node = payload.get("result", payload)` then
  `for key in ("chat_events","events","history")`. So both
  `{"chat_events":[...]}` and `{"result":{"chat_events":[...]}}` are accepted.
- Event objects are the **same** `event_name`/`payload`/`ts_ms` shape as §C2.
- **Completed vs partial assistant message.** There is **no** `done`/`complete` flag on the
  wire that either repo trusts. What they do:
  1. locate the user event (`message_id == ack.message_id`, else match `event_name=="message.user"`
     whose `event_text` equals `prompt.strip()` or contains `prompt[:80]`)
     (`ben:muse2api/chat.py:522-539`);
  2. scan events **after** it, keeping only `event_name == "message.assistant"` and
     **skipping** any with a truthy `reply_to_message_id` or `payload.reply_to_message_id`
     (`ben:muse2api/chat.py:549-551`);
  3. take the **last** non-empty text (`ben:muse2api/chat.py:552-557`) — i.e. snapshots
     overwrite, they don't append;
  4. declare complete when the text is **unchanged for `TEXT_SETTLE_SECONDS = 2.0 s`**
     (`ben:muse2api/chat.py:46`, `:570-575`, `:619-625`); first-snapshot false-positives are
     suppressed (`ben:muse2api/chat.py:628-629`); poll cadence 0.35 s while still growing,
     0.6 s otherwise (`:631-632`).
- **`delta.message_done` never appears in `/chat/history` handling** — the settle heuristic is
  the only completion signal in thread mode. This is the single most important gotcha in the
  whole protocol.

### C4. `POST /chat/subscribe`
- Route `chat.subscribe` → `POST /chat/subscribe`, `streamMode:"subscription"`
  (`ben:muse2api/protocol.py:57`).
- Body (`ben:muse2api/chat.py:660-664`, `minh:muse_ai/routes.py:48-58`):
  ```json
  {"after_stream_seq": 0, "after_chat_event_seq": 0, "capabilities": [<the 4 strings>]}
  ```
  `minh` defaults `after_chat_event_seq = after_stream_seq` and clamps both with `max(0, int(x))`.
  `0` = "from now on, replay nothing".
- **When it is needed:** only for the **main chat**. `ben:muse2api/chat.py:1-9`: *"live
  subscription deltas do not cover thread replies and race thread creation"* — so side-chat
  (thread) mode polls `/chat/history` and never calls `/chat/subscribe`. Use subscribe iff you
  want the account's main conversation with live token deltas.
- Ordering requirement: open the subscribe stream, **sleep ~0.4 s** to let it attach, then
  fire `/chat/stream` (`ben:muse2api/chat.py:673-687`, comment "let the subscribe attach").
- `/chat/subscribe` receives the whole account's event firehose, including unrelated
  `delta.presentation` events — do not treat the first unrelated event as the answer
  (`ben:tests/test_main_mode.py:21-33` documents exactly this bug).

### C5. `POST /api/nodes/register` + `POST /client/register-capabilities` — **NOT MANDATORY**
Both are wrapped in bare `try/except` that log at **debug** level and continue
(`ben:muse2api/chat.py:744-784`). Decisively: **`minh` never calls either one** — it declares
`client.register_capabilities` in its route table (`minh:muse_ai/routes.py:18`) and then never
references it; its `generate_video` path goes `history baseline → POST /chat/stream → poll
/chat/history` with zero registration
(`minh:README.md:158-166`, `minh:muse_ai/client.py:284-357`).
**Treat both as optional hints.** Skip them for your first gate.

`POST /api/nodes/register` (`ben:muse2api/chat.py:746-755`) — called *before* `/chat/stream`,
with the same `node_id` uuid:
```json
{"node_id":"<uuid4>","display_name":"Web","platform":"web",
 "commands_v2":{"ping":{"description":"Connection liveness check"}}}
```
Other node routes exist and are unused by client code: `node.list` `POST /api/nodes/list`,
`node.heartbeat` `POST /api/nodes/heartbeat`, `node.unpair` `POST /api/nodes/unpair`,
`node.disconnect` `POST /api/nodes/disconnect`, `nodes.sync` `POST /nodes/sync`,
`nodes.invoke_result` `POST /nodes/invoke-result`, `nodes.invoke_ack` `POST /nodes/invoke-ack`
(all `ben:muse2api/protocol.json`). Payloads **NOT FOUND**.

`POST /client/register-capabilities` (`ben:muse2api/chat.py:762-780`) — note the key is
**`client_id`**, not `node_id`:
```json
{"client_id":"<uuid4>","platform":"web","display_name":"Muse Web","version":"0.0.0",
 "capabilities":{"data_sources":{},"device_commands":{},"hatch_app_commands":{},
   "rendering":{"supported_presentations":["text_with_button","generic_list"],
                "supported_inline_presentations":["option"],
                "supported_text_entities":[]}}}
```
Also unused: `client.runtime_state` → `POST /api/client/runtime-state`. Payload **NOT FOUND**.
Note `ben` calls both with the *same* uuid (thread mode passes `state.node_id`; main mode
passes a fresh `client_id` — `ben:muse2api/chat.py:648,652-653`).

### C6. `POST /approvals/{id}/decide` — **service = `sentinel`, not `daemon`**
- Routes (`ben:muse2api/protocol.json`, all `svc=sentinel`): `GET /approvals`
  (`egress.approvals`), `GET /approvals/{approval_id}`, `GET /approvals/{approval_id}/editable-message`,
  `POST /approvals/{approval_id}/decide`, `POST /approvals/{approval_id}/edit-message`,
  `GET /approvals/history`.
- **Request body** (`ben:muse2api/approvals.py:230-240`; path param `approval_id` is *also*
  duplicated in the body):
  ```json
  {"approval_id":"<id>","decision":"<kind>", "reason":"<optional>",
   "always_scope":"<scope>", "allow_always_scope":"<scope>"}
  ```
  `always_scope` and `allow_always_scope` are **both** sent with the same value, only when
  `decision == "allow_always"` ("The web client sends both keys; newer daemons read the
  second one" — `ben:muse2api/approvals.py:238-240`).
- **Approval record shape** (from `GET /approvals`):
  `{"ok":true,"result":{"pending_approvals":[...]}}` — fallback key `pending`
  (`ben:muse2api/approvals.py:423-430`). Each record: `approval_id` **or** `id`
  (`:104-107`), `status` — `is_pending()` is true when `status is None` **or** `"pending"`
  (`:110-112`), `scope.thread_id` / `thread_id` / `scope.session_scope_id` / `session_scope_id`
  (`:114-121`; "Current snapshots nest the scope; older ones put the fields at top level"),
  `decision_options`: **either** bare strings **or** `{"kind": ..., "label": {"kind": ...,
  "scope": ...}}` objects (`:124-137`, `:185-205`), `server_presentation|serverPresentation|
  display` → `permissionQuestion|permission_question` → `{connector, action, kind}`
  (`:274-283`), `approval_type` (`:350`), `host`/`port` at top level **or** under
  `payload.network_payload` (`:286-292`).
- **Decision enum values (wire strings).** One-shot set (`ben:muse2api/approvals.py:46-55`):
  `allow_once`, `allow`, `allow_for_this_task`, `allow_all_web_access_for_this_task`,
  `allow_today`, `allow_for_this_scheduled_task`, `allow_for_this_artifact`,
  `allow_for_your_feed`. Plus `allow_session`, `allow_always`, `allow_always_scoped`.
  Deny set (`:56-62`): **`deny`**, `deny_always`, `deny_for_this_task`,
  `deny_for_this_scheduled_task`, `deny_for_this_artifact`.
  Scoped-always is submitted as the **plain** `allow_always` (the `_scoped` variant is an
  *offered option kind*, mapped back via `_WIRE_DECISION = {"allow_always_scoped":
  "allow_always"}` — `:76`, `:154-157`).
  Legacy daemons without `decision_options` only know three: `_LEGACY_DECISION =
  {allow_once:"allow_once", allow_session:"allow_session", allow_always:"allow_session",
  deny:"deny"}` (`:78-83`). **So: `"deny"` and `"allow_once"` are the safe literals.**
- **Only touch an approval whose `thread_id`/`session_scope_id` equals your `session_id`**
  (`ben:muse2api/approvals.py:114-121`, `ben:README.md:256-259`).
- **An unanswered approval blocks the turn until `MUSE_CHAT_TIMEOUT` (default 300 s)** —
  `ben:muse2api/approvals.py:5-8`, `ben:README.md:202-204`. Poll cadence while waiting:
  every **4.0 s** (`ben:muse2api/chat.py:491-492`).
- Related sentinel service routes, payloads **NOT FOUND**: `GET /permissions/settings`,
  `GET /permissions/active` (`ben:muse2api/approvals.py:388-390`; `active` → `{"items":[{
  "kind":"network_rule"|"transient_network_grant", "mode":..., "target":
  {"connector":{"key":..., "actions":[{"key","mode"}]} | "network":{"endpoints":[{"host"}]}}]}`),
  `GET /api/consent/status` (`ben:README.md:258`).
  Permission mode strings: `auto_allow`, `always_ask`, `allow`, `ask`, `deny`, `off`
  (`ben:muse2api/approvals.py:84-91`); scope strings: `destination_domain`, `entity`,
  `connector_all_actions` (`ben:README.md:250`); network approval kinds: `network_access`,
  `network_turn_grant`, `space_reader_web_read`, `cron_web_read` (`ben:muse2api/approvals.py:352-354`).

---

# D. MEDIA

### D1. How generated media surfaces
Assistant turns carry **`delta.presentation`** events; the artifacts live in `payload` as
`payload.data.images[]` / `payload.data.videos[]`, plus `payload.kind ∈ {"image","video"}`.
(`ben:muse2api/media.py:3-5`, `:146-156`). Event-level `resources` is also walked
(`ben:muse2api/media.py:153-155`).

Per-node fields the reader probes (`ben:muse2api/media.py:80-118`):
`path` | `image_path` | `video_path`; `url`; `variants.original` (**nested dict, `variants` =
`{"original": "<url-or-sandbox://...>"}`**); `mime` | `mime_type` | `mimeType`;
`kind`; `label` | `prompt` | `alt`; `byte_len` (int).
`minh:muse_ai/media.py:96-135` additionally probes `content_type`/`contentType`, `type`,
`resource_id`/`resourceId`, `media_handle`/`mediaHandle`.
Extension inference: video = `.mp4 .webm .mov .m4v`; image = `.png .jpg .jpeg .webp .gif`
(`ben:muse2api/media.py:103-106`, `minh:muse_ai/media.py:38`).
**Paths arrive prefixed `sandbox://`** and are normalised by stripping the scheme, `\`→`/`,
collapsing `//`, and left-stripping `/` (`ben:muse2api/media.py:71-77`). Bare `sandbox://…`
substrings are also regex-mined **out of text** — `re.finditer(r"sandbox://[^\s)\"']+", node)`
(`ben:muse2api/media.py:141-143`).

### D2. Retrieval paths — all via the Noise tunnel, plain HTTPS does NOT work
`download_media` order (`ben:muse2api/media.py:261-310`):
1. `GET /media/raw/<normalized-path>`  (path already leading-slash-stripped)
2. `GET /fs/raw/<normalized-path>` — *"The gateway accepts both /media/raw and /fs/raw; try the
   direct media route first, then fall back to the filesystem route"* (`:267-269`)
3. `GET <ref.url>` over **plain HTTPS** — last resort only, and explicitly because
   *"Signed VM URLs are not publicly reachable"* (`:289-290`).

**`/media/raw` is NOT in the 352-route `protocol.json` table** (nor in `minh`'s routes) — it is
a hardcoded string only at `ben:muse2api/media.py:269`. The table has `fs.raw` →
`GET /fs/raw/{*path}`, plus two other media routes `ben` never uses:
`idea-cards.media` → `GET /api/idea-cards/media/{handle}` and
`feed.unit.media` → `GET /api/feed/units/{unit_id}/media/{handle}`
(`ben:muse2api/protocol.json`). `minh` uses the idea-cards one as a **Hatch RPC** route, not
public HTTP — `minh:muse_ai/filesystem.py:182-197` `GET /api/idea-cards/media/<handle-urlquoted>`
and `minh:muse_ai/client.py:232-240` ("The frontend treats /idea-cards/media/<handle> as a
Hatch RPC media route, not a normal public HTTP URL").
Download attempt order in `minh` (most→least reliable, `minh:muse_ai/client.py:226-282`):
`idea-cards/media` → `media_handle` → direct http(s) → `sandbox://` via `/fs/raw` →
`ref.path` via `/fs/raw`.

**Path normalisation before the URL** matters: `normalize_gateway_path` drops the query+fragment,
strips `file://`, collapses slashes, then **truncates to the workspace root** — if `"workspace"`
appears in the segments it keeps from that segment onward, else if `parts[0] in {"home","Users"}`
and `len>=3` it drops the first two (`minh:muse_ai/filesystem.py:15-31`; `ben` has the same
function minus the truncation → **DISCREPANCY**, use `minh`'s). Then
`quote(path, safe="/")` (`ben:muse2api/filesystem.py:121`) or `safe=""` for a single handle
(`minh:muse_ai/filesystem.py:189`).
Ranges go through as a protobuf **header**, not a URL param:
`Header("Range", f"bytes={start}-{end}")` (`minh:muse_ai/filesystem.py:166-171`).
⚠ `ben`'s equivalent is broken: `ben:muse2api/filesystem.py:128` passes
`extra_headers=extra` to `HatchConnection.request`, which has **no such parameter**
(`ben:muse2api/gateway.py:487-495`) → `TypeError`. Only `minh` wires extra headers through
(`minh:muse_ai/transport.py:239,249`).

### D3. Host pattern, and tunnel vs plain HTTPS
- There is **no media host**. Media never resolves to a download host; it is fetched as the
  body of a `GET` RPC **over the already-established Noise WebSocket to
  `wss://hatch.metaaivm.com/v1/noise`** (`ben:muse2api/gateway.py:281-282` sets
  `max_message_size=16*1024*1024` for exactly this reason; `minh` uses
  `max_size=None`). Binary `ApplicationResponse.body`/`BodyChunk.data` is the file
  (`ben:muse2api/media.py:281-284`).
- `endpoint_url` from `/api/session` is carried as `GatewaySession.gateway_url`
  (`ben:muse2api/http.py:386-391`) and is used **only** as the `vmAddress` field of the token
  request (`ben:muse2api/http.py:357-360`) — **never** as a WS or media host. The WS host is
  always the shared LB (`ben:muse2api/protocol.py:23`, `minh:muse_ai/auth.py:41`).
- `minh:muse_ai/auth.py:26-31` derives `vm_id` from `vmName`, falling back to
  `urlparse(gateway_url).hostname.split(".")[0]`.
- Signed external URLs that *are* public get fetched with `curl_cffi` + Chrome impersonation,
  `allow_redirects=CurlFollow.SAFE`, 120 s (`ben:muse2api/media.py:292-305`), with an SSRF
  guard on user-supplied reference URLs (`:185-210`). Hard cap `MAX_MEDIA_BYTES = 150 MiB`
  (`:25`).
- Filesize ceiling on the tunnel itself: 16 MiB per reassembled Noise message
  (`ben:muse2api/wire.py:36`). **A >16 MiB media file cannot come through `/fs/raw` as one RPC
  response under these limits** — neither repo handles that.

### D4. Job / status API
**There is NO upstream job or status API for generated media.** The `POST /v1/images/tasks`,
`GET /v1/images/tasks/{id}`, `POST /v1/videos`, `GET /v1/videos/{id}` endpoints are the
**bridge's own local** task store (`app.state.tasks`, persisted to
`.muse-state/tasks.json`; a task interrupted by a restart is marked `failed` on startup —
`ben:README.md:448-452`, `ben:muse2api/server.py:1531-1565`). Upstream completion is detected
only by **polling `/chat/history` and diffing artifact identity**.
Polling recipe (`minh:muse_ai/client.py:168-206`): every **3.0 s**, timeout 600 s,
`settle_seconds = 5.0`, `min_videos` threshold; identity = `path or resource_id or media_handle
or url` (`minh:muse_ai/media.py:16-25`, deliberately because *"Signed URLs can rotate while the
generated file itself is unchanged"*). A **baseline** history read must be taken *before* the
prompt to diff against (`minh:muse_ai/client.py:306-307`).
`ben`'s variant waits for the media **signature** (sorted `ref.identity`) to stop changing for
**25 s**, or falls back to text-stable `35 s` when the assistant text contains an
active-verb ("search, looking, checking, finding, reference, appearance, generating, creating,
drawing, rendering, browse, wait, inspect, query") else `15 s`
(`ben:muse2api/chat.py:586-618`).
`ben:README.md:416-419`: **video is account- and region-gated upstream**; refusal is cached and
re-raised as HTTP 503 `video_unavailable_region` for `MUSE_VIDEO_BLOCK_SECONDS` (default 21600).
`ben:muse2api/chat.py:50-159` is a ~100-entry `MEDIA_REFUSAL_MARKERS` list (English + Chinese)
used to abort early — worth copying verbatim, it is the only concrete record of the refusal
strings observed on the wire.

---

# E. SECONDARY-CHECK ITEMS

### E1. `www` `HttpDriver.chat_stream` → 501: **CONFIRMED**
`www:src/muse2api/drivers/http/driver.py:40-42`:
```python
async def chat_stream(self, account, req) -> AsyncIterator[str]:
    raise FeatureNotImplemented("http driver chat is not implemented yet; use driver=browser")
    yield ""  # pragma: no cover
```
`capabilities = DriverCapabilities(renew_session=True)` only (`:35`) — and
`www:src/muse2api/drivers/base.py:127-128` makes every other capability raise
`FeatureNotImplemented` → HTTP 501. The module docstring (`:1-20`) is an open TODO: *no
`docs/protocol.md` exists* — `find` for it returns nothing. **`www` contains zero HTTP/SSE chat
path. `czg` likewise (grep for "noise" in `engine.py`/`app.py`/`cdp.py` → no hits; its README
line 24 says "Noise WebSocket 隧道亲和复用" but that is marketing copy for CDP tab reuse).**

### E2. Auth refresh — better than what you have
- **`hatch_gw` / `hatch_vml` are OPTIONAL.** `www:src/muse2api/upstream/muse.py:26-31`:
  *"As of 2026-10 muse.ai no longer sets hatch_gw / hatch_vml for every logged-in session, so
  they are optional: forwarded when present, but not required."*
  Required set = `("hatch_sess", "hatch_native_auth_device")`; optional =
  `("hatch_gw", "hatch_vml")`. `ben` requires only `hatch_sess` (`ben:muse2api/http.py:111-115`).
- **Cookie TTLs**: `hatch_vml` +48 h, `hatch_sess` +30 d, `hatch_gw` +1 y
  (`czg:engine.py:537`). `ben:README.md:316-318` — re-export needed only after logout or
  >48 h VM disuse.
- **Cookies rotate on use.** `/api/session` itself rotates them (`ben:muse2api/http.py:284-289`
  — persists immediately after that call). Store the *live* jar, not the export.
- **403 on `/api/hatch/token` usually means stale `hatch_vml`** → refresh `/api/session` once
  and retry (`ben:muse2api/http.py:361-368`, and `:261-266` comment).

### E3. VM wake — better than what you have
- **`POST /api/hatch/vm/wake` returns HTTP 403 for a VM that is ALREADY RUNNING** — so 403 is
  not an error. `www:src/muse2api/upstream/muse.py:132-134`: *"The wake's own answer says
  little … Judge by the state the session reports."* `ben` sends it with `require_ok=False`
  for this reason (`ben:muse2api/http.py:292-301`).
- `retry_count`: you used `0`; `www` uses `0` (`…/muse.py:126`), `czg` uses `0`
  (`czg:engine.py:589`), **`ben` uses `1`** (`ben:muse2api/http.py:296`). Both accepted.
- Skip wake when `vm_state == "DISABLED"` (`www:…/muse.py:121`, `czg:engine.py:585`).
- Confirm `RUNNING` by polling `/api/session` every **2.0 s** up to **20 s**
  (`www:…/muse.py:41-42`, `WAKE_CONFIRM_SECONDS`/`WAKE_POLL_SECONDS`, overridable via
  `MUSE2API_WAKE_CONFIRM_S`). `ben` allows 45 s plus a **1.2–1.6 s settle sleep** after
  RUNNING, because *"the VM's noise listener binds"* needs that grace before the WS upgrade
  (`ben:muse2api/http.py:349-353`) — this is why your upgrade might intermittently 502.
- Transient WS-upgrade failures to retry with backoff 1.0 s → ×1.5 capped 3.0 s, 4 attempts:
  codes `502, 503, 504, "Bad Gateway", "Refused WebSocket upgrade"`, plus
  `ConnectionResetError`/`ConnectionRefusedError` (`ben:muse2api/gateway.py:268-299`).
- `vm_resolution_issue` is the failure field when no VM is assigned (`ben:muse2api/http.py:340-344`).
- `/api/session` accepts `?vm_state=live` (as you found) — `ben:muse2api/http.py:285`.
  Recognised states: `assigned` (status), and `vm_state` ∈ `SUSPENDED`, `RUNNING`, `STARTING`,
  `WAKING`, `DISABLED`; `status` ∈ `unavailable`, `pending` (`ben:muse2api/http.py:315-323`).

### E4. Token endpoints — **`GET` is not what these repos use**
Your `GET /api/hatch/token` worked, but both browserless clients use **POST with a body**:
```
POST https://muse.ai/api/hatch/token
  {"vmAddress": <endpoint_url from /api/session>, "vmName": <vm_id>}
  -> {"token": ..., "notary_token": ...}          ben:muse2api/http.py:356-369
                                                   minh:muse_ai/auth.py:384-404
```
Response key is `token` (auth) and **`notary_token`** (snake) on this endpoint
(`minh:muse_ai/auth.py:400-401`).
A **separate** endpoint gives the notary token in camelCase:
```
POST https://muse.ai/api/hatch/noise-notary-token
  {"vmName": <vm_id>}  ->  {"notaryToken": "..."}   ben:muse2api/http.py:375-382
```
`ben` treats notary as **optional** (warns and continues without it) —
`ben:muse2api/http.py:383-384`. WS URL omits `notary_token` entirely when absent
(`ben:muse2api/gateway.py:115-116`).
Third source of all four at once — scrape `https://muse.ai/` HTML for quoted JSON fields
`gatewayUrl`, `vmName`, `authToken`, `notaryToken`, `viewerLocale` (`minh:muse_ai/auth.py:332-363`).

### E5. Quota
**No quota endpoint on the wire.** Both secondary repos read quota by **DOM-scraping the web
UI** (`www:src/muse2api/drivers/browser/dom.py:185-186`: *"The quota lives in the dock's
Settings menu -> Settings -> General -> Usage:"*) — not a protocol fact. `HttpDriver`
declares no `quota` capability → HTTP 501
(`www:src/muse2api/api/routes/admin.py:169-185`, `www:src/muse2api/drivers/base.py:94,127-128`).
The only wire-level quota signal available to you is **textual**: the assistant refuses with
"out of credits" / "quota" / "limit reached" (`ben:muse2api/chat.py:146-151`). Quota exhaustion
surfaces as `UpstreamQuotaError` from browser scraping only (`www:…/driver.py:445-447`).

### E6. Model selection
**There is no model-selection parameter on the wire.** `muse-chat`/`muse-image`/`muse-video`
and all the gpt/claude/sora aliases are **purely local** OpenAI-compat naming invented by `www`
(`www:src/muse2api/core/models.py:18-45`) and `muse-spark` is a `ben` display string
(`ben:README.md:400`). Nothing is passed to muse.ai; you get whatever the account's agent is
configured with. The only read-only probe is `GET /model` (`model.get`,
`ben:muse2api/protocol.py:52`, `minh:muse_ai/routes.py:17`) → returns the active model.
**Exact `/model` response shape: NOT FOUND** (only `response.text()[:300]` is printed,
`ben:muse2api/__main__.py:41-42`).

### E7. WS upgrade headers used by `ben`
`ben:muse2api/gateway.py:63-79` — `Origin: https://muse.ai`, `Accept: */*`,
`Accept-Language: en-US,en;q=0.9,en-GB;q=0.8`, `Sec-Fetch-Mode: websocket`,
`Sec-Fetch-Site: cross-site`, `Pragma: no-cache`, `Cache-Control: no-cache`,
`Sec-Fetch-Dest: websocket` (Chrome) / `empty` + `Sec-Fetch-Storage-Access: none` (Firefox).
URL params exactly as you found them (`ben:muse2api/gateway.py:109-117`), `app_id` default
`hatch-web`, `request_id` a fresh uuid4 per connect.
`ben:README.md:359-390` stresses the **TLS/HTTP2 fingerprint is load-bearing**: Meta's edge
rejects some stock fingerprints on authenticated routes (`ben:muse2api/http.py:1-6`), pinned
JA4 `t13d1516h2_8daaf6152771_806a8c22fdea` ("the canonical Chrome value",
`ben:README.md:367-368`), HTTP/2 pinned (`MUSE_HTTP_VERSION=2`), h3 opt-in because libcurl's
QUIC transport params differ from Chromium's. Cookies must live in the session jar, not a
hand-built `Cookie` header (`ben:README.md:379-380`). Since your Node client already gets
`101 Switching Protocols`, the WS upgrade at least is not currently fingerprint-blocked.

---

# APPENDIX 1 — protobuf schema

**No `.proto` file exists in any of the four repositories** (`find -name "*.proto"` → empty
across `ben`, `www`, `czg`, `minh`). **There is no verbatim `.proto` text to reproduce.**
What exists is (i) the `ben:muse2api/wire.py:1-20` docstring, reproduced verbatim in §B1, and
(ii) the hand-written encoders/decoders cited there.

For convenience, the same field numbers rendered as an actual proto3 file. **This is a
mechanical restatement of the docstring in §B1 — the field numbers and wire types are sourced;
the `syntax`/`package`/`option` lines and message/enum *names* are formatting only.** Nothing
here should be treated as a recovered schema artifact.

```proto
syntax = "proto3";

// One reassembled Noise transport message. chunk_index/total_chunks fragment a single
// logical message across multiple WS frames; chunk_id is a RANDOM signed int64 shared by
// all fragments of one message (minh:muse_ai/wire.py:262-263 -> struct.unpack("<q", urandom(8))).
message NoiseTransportFrame {
  int64  chunk_id     = 1;  // varint
  uint32 chunk_index  = 2;  // varint, 0-based
  uint32 total_chunks = 3;  // varint, >= 1
  bytes  payload      = 4;  // length-delimited
}

enum ServiceType {          // ben:muse2api/wire.py:241-244
  DAEMON   = 0;
  SENTINEL = 1;
  VAULT    = 2;
  AUTHD    = 3;
  // ssh_access is referenced by name only in protocol.json; NUMERIC VALUE UNKNOWN.
}

// Client -> server envelope (field 1 is always emitted, even for service 0).
message ServiceRequest {
  ServiceType service = 1;  // varint
  bytes         payload = 2;  // length-delimited ServiceFrame
}

// Server -> client envelope. Decoder reads field 1 only; ALL inbound frames are this shape.
message ServiceResponse {
  bytes payload = 1;        // length-delimited ServiceFrame
}

message ServiceFrame {      // oneof -> exactly one of 2/3/4/5
  int64 stream_id = 1;      // varint, signed64; client allocates from 1 upward
  ApplicationRequest  request    = 2;
  ApplicationResponse response   = 3;
  BodyChunk           body_chunk = 4;
  Reset               reset      = 5;
}

message ApplicationRequest {
  string verb   = 1;        // "POST" / "GET" / "PATCH" / "DELETE", uppercased
  string path   = 2;        // RPC path; GET query string folded in here
  repeated Header headers = 3;
  bytes  body   = 4;        // OMITTED when empty
  bool   end_body = 5;      // ALWAYS emitted, even when false
}

message ApplicationResponse {
  int32  status   = 1;      // varint, HTTP-style; >= 400 is an error
  repeated Header headers = 2;
  bytes  body     = 3;      // NDJSON, or raw binary for /fs/raw & /media/raw
  bool   end_body = 4;
}

message BodyChunk {
  bytes data    = 1;
  bool  end_body = 2;
}

message Header {
  string key   = 1;
  string value = 2;
}

message Reset {
  Code   code   = 1;        // varint; clients send 1 and only ever read it back
  string reason = 2;        // e.g. "client aborted", "client done", "ack only"
}

// Noise msg1 payload (SENT IN THE CLEAR), ben:muse2api/noise.py:191-194.
message NoiseHandshakeMessage1 {
  bytes client_nonce = 1;   // exactly 32 random bytes -> literal 0x0A 0x20 <32B>
}

// Noise msg2 payload for CONFIDENTIAL VMs only (ben:muse2api/cvm.py:67-113).
// Any msg2 payload failing this strict shape is treated as an opaque standard-VM
// attestation blob instead. state 1 = UNPROVISIONED (no vm_proof), 2 = PROVISIONED
// (vm_proof required, exactly 32 bytes). attestation and vm_nonce(32B) are both required.
message NoiseHandshakeMessage2 {
  bytes attestation = 1;
  int32 state       = 2;
  bytes vm_nonce    = 3;
  bytes vm_proof    = 4;
  bytes chip_binding = 5;
}

// Noise msg3 payload for CONFIDENTIAL VMs only (ben:muse2api/cvm.py:164-173).
// field 2 tag is literally 0x12 when fresh, 0x1a when recovery — i.e. field 2 for the
// RV key and field 3 for the client proof. Standard VMs send NO msg3 payload at all.
message NoiseHandshakeMessage3 {
  string notary_token = 1;
  bytes  fresh_rv_key_or_proof = 2;
}
```

RV/HMAC constants for the CVM branch only (all `ben:muse2api/cvm.py:26-30,134-149`):
```
PROOF_KEY_DOMAIN    = "hatch.noise-auth.key.v1"
VM_PROOF_KEY_LABEL  = "vm-proof-key"
CLIENT_PROOF_KEY_LABEL = "client-proof-key"
VM_PROOF_DOMAIN     = "hatch.noise-auth.vm-proof.v1"
CLIENT_PROOF_DOMAIN = "hatch.noise-auth.client-proof.v1"
proof_key       = HMAC_SHA256(rv_key, PROOF_KEY_DOMAIN || label)
vm_proof        = HMAC_SHA256(proof_key(rv,VM_PROOF_KEY_LABEL),
                  VM_PROOF_DOMAIN || msg1_transcript || client_nonce || vm_nonce)
client_proof    = HMAC_SHA256(proof_key(rv,CLIENT_PROOF_KEY_LABEL),
                  CLIENT_PROOF_DOMAIN || msg2_transcript || vm_nonce || client_nonce)
```

---

# APPENDIX 2 — items I could NOT determine

| item | status |
|---|---|
| `/api/ping` response body shape | **NOT FOUND** — neither repo parses it; only `status < 400` is checked |
| `/model` response body shape | **NOT FOUND** — only `response.text()[:300]` printed |
| `ServiceType` numeric value for `ssh_access` | **NOT FOUND** — defined only as a string in `protocol.json` |
| `Reset.Code` enum members | **NOT FOUND** — clients send literal `1`, never enumerate server codes |
| Full `delta.*` / `event` name universe | **NOT FOUND** — only the 5 names in §C2 appear in code. Of the 352 routes in `protocol.json`, only ~20 are exercised by client code; the rest are unverified route strings |
| `POST /chat/stream-events` request/response | **NOT FOUND** — route exists, no caller |
| `GET /chat/history-window` | **NOT FOUND** — route exists, no caller |
| `/api/nodes/list`, `/nodes/sync`, `/nodes/invoke-*`, `/api/nodes/heartbeat` payloads | **NOT FOUND** — routes only, no callers |
| `POST /api/client/runtime-state` payload | **NOT FOUND** |
| Upstream image/video job-status API | **DOES NOT EXIST** (§D4) — completion is polled from `/chat/history` |
| Media download host | **DOES NOT EXIST** (§D3) — media comes through the tunnel |
| Any attestation-verifier implementation | **NOT FOUND** — `ben` delegates to an external binary via `MUSE_ATTESTATION_CMD` (`ben:muse2api/cvm.py:195-239`); AMD/SEV-SNP chain intentionally not implemented (`ben:README.md:353-357`) |
| Server static-key pinning / trust anchor | **DOES NOT EXIST** (§A2) |
| Whether msg2's standard-VM attestation blob has any structure | **NOT FOUND** — `ben:muse2api/gateway.py:349-352` logs its byte length and discards it |
