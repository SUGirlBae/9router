# Báo cáo Phân tích Chi tiết: AgentProxyRover v0.2.0

**Research Date:** November 5, 2026  
**Repository:** https://github.com/duonglabs/AgentProxyRover  
**Version Tag:** v0.2.0

---

## 🎯 Tổng quan (Executive Summary)

### **Mục đích chính:**
AgentProxyRover là một **Electron app** cho phép local AI agents sử dụng các HTTP proxy đã được lọc từ nguồn công khai miễn phí. Nó hoạt động như một gateway chuyển đổi public proxy lists thành local endpoints an toàn qua MCP server.

### **Problem Statement:**
```
Trước: Public proxy lists rất "noisy" (nhiều IP không khỏe, chậm, chết liên tục)
      - Khó filter thủ công
      - Không phù hợp cho AI agents cần reliability
      
Sau:  AgentProxyRover
      ✓ Tự động filter → healthy exits
      ✓ Up to 20 proxies per IP address
      ✓ Local MCP server interface
      ✓ Secure (binds to 127.0.0.1 only)
```

---

## 🔧 Kiến trúc & Components

### **Architecture Overview:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Public Proxy Sources                         │
│  Free proxy lists (scraped/aggregated)                          │
│  └── Noisy, unreliable, frequently dead                        │
└───────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                 AgentProxyRover Core                            │
│                                                                  │
│  1. Filter Layer                                                │
│     - Health check: ping/response time/capability               │
│     - Remove noisy/slow/dead exits                              │
│                                                                  │
│  2. Pool Service (hosted by Shiplo.site)                        │
│     - Manages up to 20 working proxies per source IP            │
│     - Rotates based on success rate                             │
│                                                                  │
│  3. MCP Server (:6789)                                          │
│     - JSON-RPC over HTTP                                        │
│     - Tools: list, reset_proxy, start, stop                     │
│                                                                  │
│  4. HTTP Proxy Endpoints (:8801+)                                │
│     - Multiple local ports mapped to different exit IPs         │
│     - Binds to 127.0.0.1 (localhost only)                       │
└───────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Local Agents                               │
│  Claude Code / VSCode / Qoder / Other AI tools                  │
│  Can now use filtered proxies securely via MCP or direct HTTP   │
└───────────────────────────────────────────────────────────────┘
```

### **Key Components:**

| Component | Port | Function | Technology |
|-----------|------|----------|------------|
| **MCP Server** | `127.0.0.1:6789` | AI control interface | HTTP transport + JSON-RPC |
| **HTTP Proxies** | `127.0.0.1:8801+` | Actual proxy endpoints | HTTP/HTTPS proxy protocol |
| **Filter Engine** | internal | Health checking logic | Node.js runtime |
| **Pool Manager** | hosted (Shiplo) | Exit IP management | Cloud service |

---

## 📦 Installation v0.2.0

### **Download Links:**

#### Windows Build (recommended):
```bash
# Installer version (per-user, creates Start Menu shortcut)
https://github.com/duonglabs/AgentProxyRover/releases/download/v0.2.0/AgentProxy-Setup-*.exe

# Portable version (single executable, no install needed)
https://github.com/duonglabs/AgentProxyRover/releases/download/v0.2.0/AgentProxy-Portable-*.exe
```

**Binary Types:**
- **AgentProxy-Setup-[version].exe** — Standard installer
- **AgentProxy-Portable-[version].exe** — Self-contained portable exe

### **Installation Steps:**

#### Option A: Installer Mode
```powershell
# Download installer
curl -LO https://github.com/duonglabs/AgentProxyRover/releases/download/v0.2.0/AgentProxy-Setup-x.x.x.exe

# Run installer (creates shortcut in Start Menu)
./AgentProxy-Setup-x.x.x.exe

# Verify installation
where agentproxy
# Output: C:\Users\<User>\AppData\Local\Programs\AgentProxy\agentproxy.exe
```

#### Option B: Portable Mode
```powershell
# Download portable exe
curl -LO https://github.com/duonglabs/AgentProxyRover/releases/download/v0.2.0/AgentProxy-Portable-x.x.x.exe

# Run directly (no install required)
./AgentProxy-Portable-x.x.x.exe
```

#### Option C: From Source
```bash
# Clone repository
git clone https://github.com/duonglabs/AgentProxyRover.git
cd AgentProxyRover

# First-time setup
npm install

# Run development mode
npm start

# Build production dist (optional)
npm run dist
```

### **System Requirements:**

| Platform | Minimum | Recommended |
|----------|---------|-------------|
| OS | Windows 10/11 | Windows 11 latest |
| RAM | 512 MB | 2 GB |
| Disk | 100 MB | 1 GB |
| Network | Internet access | Stable broadband |
| Node.js | 18.x+ (source build) | 20.x LTS |

---

## 🚀 Usage Guide

### **1. Connect Agent via MCP Server**

After running AgentProxyRover, connect your AI agent using MCP:

```bash
# For Claude Code
claude mcp add --transport http agentproxy http://127.0.0.1:6789/mcp

# Verify connection
claude mcp list

# Should output:
# Available tools:
# - list_local_endpoints()
# - reset_proxy(exit_ip)
# - start_proxy()
# - stop_proxy()
```

### **2. Direct HTTP Proxy Access**

AgentProxyRover also exposes plain HTTP proxies at multiple ports:

```bash
# Test proxy endpoint 1
curl -x http://127.0.0.1:8801 https://api.ipify.org?format=json

# Expected response (your exit IP):
# {"ip":"<exit-IP-address-from-proxy-pool>"}

# Try other available ports
for i in 8801 8802 8803 8804 8805; do
  echo "Port $i:"
  curl -s -m 5 -x http://127.0.0.1:$i https://api.ipify.org?format=json
done
```

### **3. Using MCP Tools**

Once connected via MCP, you can call tools from your AI agent:

#### **List All Live Endpoints:**
```javascript
// Example tool call in agent code
await list_local_endpoints();

// Returns array of available proxied endpoints
[
  { port: 8801, ip: "45.32.123.45", country: "US", latency_ms: 234 },
  { port: 8802, ip: "178.123.45.67", country: "DE", latency_ms: 156 },
  // ... up to 20 proxies per source IP
]
```

#### **Reset/Change Proxy Exit IP:**
```javascript
// Rotate to next available exit
await reset_proxy();

// Or specify specific exit IP
await reset_proxy("45.32.123.45");
```

#### **Start/Stop Proxy Globally:**
```javascript
// Start proxy service
await start_proxy();

// Stop proxy service (all ports go offline)
await stop_proxy();
```

### **4. Integration Examples**

#### **VSCode / Qoder Usage:**
Configure your IDE proxy settings to point to `http://127.0.0.1:8801` when you want AI responses through specific geographic locations.

#### **API Client Testing:**
```bash
# cURL example with proxy
curl -x http://127.0.0.1:8801 \
  -H "User-Agent: MyCustomAgent/1.0" \
  https://example.com/api/data

# Python requests example
import requests

proxies = {
    'http': 'http://127.0.0.1:8801',
    'https': 'http://127.0.0.1:8801'
}

response = requests.get('https://api.example.com/data', proxies=proxies)
```

---

## 🛡️ Security Considerations

### **Critical Security Measures:**

#### **1. Local Binding Only**
```
✅ Always binds to 127.0.0.1 (localhost)
❌ Never exposed to external network
🔒 Prevents unauthorized remote access
```

#### **2. No Sensitive Data Policy**
⚠️ **WARNING:**
> "Never send credentials, personal data or anything sensitive through free proxies"

**Recommended Practices:**
- Use unencrypted traffic only
- Low-sensitivity data requests
- Avoid authentication tokens/passwords
- Don't access banking/financial sites

#### **3. Exit IP Transparency**
Exit IPs are **third-party managed**:
- Subject to unexpected downtime
- Not owned/controlled by AgentProxyRover
- Rotation automatic via pool service

#### **4. Sponsorship Note:**
Project uses hosted pool service sponsored by **[Shiplo.site](https://shiplo.site)**:
- External dependency
- May change pricing/policies
- Monitor for sustainability

---

## 🔍 Features Deep Dive

### **Feature 1: Smart Filtering**

AgentProxyRover filters "noisy" public proxy lists by:
1. **Health Check:** Ping/responsetime measurement
2. **Capability Verification:** Does endpoint support HTTP/HTTPS?
3. **Stability Score:** Track uptime over rolling window
4. **Anonymity Level:** Strip/repack headers appropriately

Result: **"Up to 20 working proxies per IP"**

### **Feature 2: Geographic Diversity**

Each exit IP typically has multiple exit points:
```
Source IP: 45.32.123.45 (US)
  ├→ Proxy 1: Port 8801 → Exit as 45.32.123.45:8001
  ├→ Proxy 2: Port 8802 → Exit as 45.32.123.45:8002
  ├→ Proxy 3: Port 8803 → Exit as 45.32.123.45:8003
  └→ ... up to 20 variants
```

This allows:
- Load distribution
- IP rotation resistance mitigation
- Regional testing (same country, different cities)

### **Feature 3: MCP Integration**

Full MCP server implementation provides:
- **Tool discovery:** List available tools automatically
- **Type safety:** Input validation via MCP schema
- **Streaming:** Support for partial updates
- **Error handling:** Structured error responses

---

## ⚠️ Known Limitations & Troubleshooting

### **Limitation 1: Downtime of Free Proxies**
```
Problem: Exit IPs may go offline unexpectedly
Workaround: 
  - Auto-retry via reset_proxy()
  - Switch to alternative endpoint port
  - Wait for pool service to detect failure
```

### **Limitation 2: Third-Party Dependency**
```
Problem: Shiplo.site sponsorship is external dependency
Risk: Future pricing changes or service discontinuation
Mitigation:
  - Monitor project status regularly
  - Have backup proxy strategy ready
  - Contribute to upstream if critical
```

### **Troubleshooting Common Issues:**

#### **Issue: MCP connection fails**
```
Error: "Cannot connect to agentproxy MCP server"
Diagnosis: AgentProxyRover not running or wrong URL
Fix:
  1. Ensure AgentProxyRover process is active
  2. Check firewall blocks port 6789
  3. Verify URL: http://127.0.0.1:6789/mcp
```

#### **Issue: All proxies offline**
```
Symptom: All 8801+ ports return timeout/connection refused
Diagnosis: Pool service temporarily down or network issue
Fix:
  1. Restart AgentProxyRover application
  2. Wait 2-5 minutes for pool service recovery
  3. Check internet connectivity independently
```

#### **Issue: Slow response times**
```
Problem: Proxy requests very slow (>5 seconds)
Cause: Free proxies often overloaded
Solutions:
  - Use reset_proxy() to switch to faster exit
  - Filter results by latency_ms before selection
  - Accept slower performance for cost savings
```

---

## 📊 Comparison: AgentProxyRover vs Alternatives

| Feature | AgentProxyRover | Commercial VPN | Free Proxy Lists | Manual Setup |
|---------|----------------|----------------|------------------|---------------|
| Cost | ✅ Free | ❌ Paid ($5-30/mo) | ✅ Free | ✅ Free |
| Ease of use | ✅ Easy (one-click) | ✅ Very easy | ❌ Manual filtering | ❌ Complex |
| Reliability | ⚠️ Variable | ✅ High | ❌ Low | ✅ Depends |
| Privacy | ⚠️ Medium* | ✅ High | ❌ Unknown | ✅ Configurable |
| Location diversity | ✅ Good (geographic spread) | ✅ Excellent | ⚠️ Limited | ✅ Global |
| Control | ✅ Full via MCP | ⚠️ GUI only | ✅ Full manual | ✅ Full |
| Anonymity | ⚠️ Basic | ✅ Advanced | ❌ Minimal | ✅ Customizable |

*Based on third-party managed exit IPs

---

## 🔄 Version History & Roadmap

### **v0.2.0 (Current)**
**Release Highlights:**
- ✅ Windows installer + portable builds
- ✅ MCP server for AI integration
- ✅ Up to 20 proxies per source IP
- ✅ Health filtering engine
- ✅ Local-only binding for security

**Release Notes:** See GitHub releases page for full changelog

### **Expected Future Versions:**
- **v0.3.0 (Tentative):** Linux/macOS builds
- **v0.4.0:** Enhanced anonymity levels
- **v1.0.0:** Enterprise features (dedicated IPs, API quotas)

---

## 💡 Recommendations

### **When to Use AgentProxyRover:**

✅ **Recommended Scenarios:**
- Local AI experiments requiring geographic diversity
- Testing web applications from different regions
- Scraping/respectful crawling with distributed exits
- Prototyping without budget for commercial services

❌ **Not Recommended:**
- Handling sensitive credentials/payment info
- Production-grade anonymization needs
- Mission-critical operations (high availability guarantees)
- Compliance-sensitive environments (GDPR/HIPAA)

### **Best Practices:**

1. **Monitor Proxy Health:**
   ```bash
   # Regular health checks
   while true; do
     curl -s -m 2 http://127.0.0.1:8801 https://api.ipify.org?format=json && sleep 60
   done
   ```

2. **Use MCP Tools Over Raw Proxies:**
   - More robust error handling
   - Automatic rotation
   - Better logging and diagnostics

3. **Have Backup Strategy:**
   - Maintain commercial VPN subscription
   - Keep multiple proxy sources
   - Cache responses when possible

4. **Contribute Back:**
   - Report successful/failed exits
   - Contribute improved filtering algorithms
   - Help maintain open-source nature

---

## 🔗 Useful Links

| Resource | URL | Description |
|----------|-----|-------------|
| **Main Repository** | https://github.com/duonglabs/AgentProxyRover | Source code, issues, discussions |
| **Releases Page** | https://github.com/duonglabs/AgentProxyRover/releases | Download binaries (v0.2.0+) |
| **License File** | https://github.com/duonglabs/AgentProxyRover/blob/main/LICENSE | License terms (check for type) |
| **Sponsor (Shiplo)** | https://shiplo.site | Hosted pool service sponsor |
| **MCP Documentation** | https://modelcontextprotocol.io | Learn more about MCP protocol |

---

## 🎓 Technical Deep Dive (For Developers)

### **How Filtering Works:**

```javascript
// Simplified filtering logic pseudo-code

async function filterProxies(proxyList) {
  const healthy = [];
  
  for (const proxy of proxyList) {
    const health = await checkHealth(proxy);
    
    if (health.status === 'up' && 
        health.latency_ms < 2000 &&
        health.anonymity >= 'transparent') {
      
      healthy.push({
        id: generateId(),
        proxy,
        health,
        lastChecked: Date.now()
      });
    }
  }
  
  // Sort by latency (fastest first)
  return healthy.sort((a, b) => a.health.latency_ms - b.health.latency_ms);
}

async function checkHealth(proxy) {
  const startTime = Date.now();
  
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      proxy: proxy.url,
      timeout: 2000
    });
    
    const latency = Date.now() - startTime;
    const body = await response.json();
    
    return {
      status: 'up',
      latency_ms: latency,
      exitIp: body.ip,
      anonymity: determineAnonymity(response.headers),
      lastCheck: Date.now()
    };
    
  } catch (error) {
    return {
      status: 'down',
      latency_ms: null,
      error: error.message
    };
  }
}
```

### **MCP Server Implementation:**

```typescript
// Conceptual MCP server structure

class AgentProxyServer {
  private endpoints: Map<number, ProxyEndpoint>;
  private poolManager: PoolService;
  
  constructor() {
    this.endpoints = new Map();
    this.poolManager = new ShiploPoolClient();
  }
  
  async listLocalEndpoints(): Promise<EndpointInfo[]> {
    return Array.from(this.endpoints.values())
      .filter(e => e.isHealthy)
      .map(e => ({
        port: e.port,
        ip: e.exitIp,
        country: e.country,
        latency_ms: e.latencyMs
      }));
  }
  
  async resetProxy(targetIp?: string): Promise<void> {
    const selectedIp = targetIp || await this.poolManager.getNextExit();
    const newEndpoint = await this.allocateEndpoint(selectedIp);
    this.endpoints.set(newEndpoint.port, newEndpoint);
  }
  
  async startProxy(): Promise<void> {
    const endpoint = await this.createHttpProxy(8801 + this.endpoints.size);
    this.endpoints.set(endpoint.port, endpoint);
  }
  
  async stopProxy(): Promise<void> {
    // Stop all proxy endpoints
    for (const endpoint of this.endpoints.values()) {
      endpoint.close();
    }
    this.endpoints.clear();
  }
}
```

---

## 📝 Conclusion

### **Summary:**

AgentProxyRover v0.2.0 is a **practical tool** for AI agents needing reliable proxy access:

✅ **Strengths:**
- Easy-to-use Electron app
- MCP server integration for modern AI workflows
- Smart filtering removes noisy/free proxy noise
- Secure local-only binding
- Completely free

⚠️ **Trade-offs:**
- Third-party exit IP dependencies
- Variable reliability (typical for free services)
- Sponsorship via Shiplo.site creates future uncertainty
- No encryption guarantee through proxies

### **Recommendation:**

**Use Case Priority:**

1. **Excellent for:** Development/testing, learning, prototyping, personal experiments
2. **Acceptable for:** Non-critical scraping, low-stakes automation, educational purposes
3. **Not suitable for:** Production systems, sensitive data handling, compliance-heavy scenarios

**Alternative Path:**
If AgentProxyRover becomes unsustainable:
- Commercial VPN (~$10/month) provides better reliability
- Self-hosted proxy infrastructure offers full control
- Hybrid approach (free for dev, paid for prod) balances cost/reliability

---

**End of Analysis Report**  
*Generated: November 5, 2026*  
*Source: duonglabs/AgentProxyRover repository @ v0.2.0*
