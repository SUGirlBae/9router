# Kế Hoạch Tích Hợp Local Proxy Chất Lượng Cao Cho 9router

**Date:** November 5, 2026  
**Goal:** Thiết kế hệ thống proxy local "xịn" có thể hoạt động tối đa hiệu quả với 9router

---

## 🎯 Vấn Đề & Giải Pháp

### **Current State:**
9router **không có proxy layer** - direct connections đến upstream (api.qoder.sh, api.deepseek.ai, etc.)

**Problems:**
1. ❌ IP bans từ upstream khi requests quá nhiều
2. ❌ Geo-blocking cho regional models
3. ❌ Rate limiting không được distribute across IPs
4. ❌ Single point of failure: 1 IP down = outage toàn bộ

### **Solution:** Integrate high-quality proxy infrastructure

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│  VSCode / Qoder CLI → Point to :20129 instead of :20128        │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│               9router Hedge Gateway (:20129)                   │
│                                                                  │
│  ✓ Existing account rotation                                   │
│  ✓ Retry logic + timeout hedging                               │
│  ✓ Lane pinning for model-specific connections                  │
└───────────────────────────────────────────────────────────────┘
                              ↓
              ┌─────────────────────┬─────────────────────┐
              ▼                     ▼                     ▼
    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
    │  Datacenter     │   │ Residential     │   │ Mobile          │
    │  Proxies        │   │ Proxies         │   │ Proxies         │
    │  Port: 20130    │   │ Port: 20131     │   │ Port: 20132     │
    │  ~95% success   │   │ ~98% success    │   │ ~99% success    │
    └─────────────────┘   └─────────────────┘   └─────────────────┘
              │                     │                     │
              └─────────────────────┴─────────────────────┘
                              ↓
                    [Upstream APIs]
            qoder.sh | deepseek.ai | muse.ai
```

---

## 📊 Phân Tích Các Loại Proxy Available

### **Loại 1: Datacenter Proxies**

**特点:**
- ✅ Fast speed (<100ms latency)
- ✅ Cheap (~$0.5/GB)
- ❌ Easily detected as proxies
- ❌ Often blacklisted by major services
- ✅ Good for non-sensitive scraping

**Recommended Providers:**
| Provider | Price/GB | Success Rate | Rotation | Geo Coverage |
|----------|----------|--------------|----------|--------------|
| Bright Data | $10-$30 | 85-90% | ✅ Auto | Global |
| Smartproxy | $8-$15 | 88-92% | ✅ Auto | 195+ countries |
| IPRotate | $7-$12 | 85-90% | ✅ Sticky | Worldwide |

**Use Case:** Non-critical API calls, testing environments

---

### **Tipo 2: Residential Proxies** ⭐ RECOMMENDED

**特点:**
- ✅ High anonymity (~98% success rate)
- ✅ Real user IPs (harder to detect)
- ✅ Bypass most anti-bot systems
- ❌ Slower (200-500ms latency)
- ❌ More expensive (~$5-15/GB)
- ✅ Essential for sensitive operations

**Recommended Providers:**
| Provider | Price/GB | Success Rate | Features | Notes |
|----------|----------|--------------|----------|-------|
| **Bright Data** | $15-$30 | 95-98% | ✅ City-level targeting, ASN filtering | Premium quality |
| **Illuminated** | $12-$25 | 94-97% | ✅ ISP fallback, custom rotators | Best value |
| **SOAX** | $10-$20 | 93-96% | ✅ Easy rotation, good docs | Beginner-friendly |

**Use Case:** Production workloads, critical AI agent operations

---

### **Tipo 3: Mobile Proxies**

**特点:**
- ✅ Highest trust score (~99% success)
- ✅ Carriers' real mobile IPs
- ❌ Very slow (500ms-2s)
- ❌ Expensive ($15-40/GB)
- ✅ Almost undetectable

**Recommended Providers:**
- Smartproxy Mobile: $18/GB, carriers: Verizon/Vodafone/T-Mobile
- IPRotate Mobile: $12/GB, Asian/European focus
- Webscrape Mobile: $20/GB, global coverage

**Use Case:** Extremely sensitive operations, bypassing strict restrictions

---

### **Tipo 4: ISP Proxies (Hybrid)**

**特点:**
- ✅ Combines datacenter speed + residential trust
- ✅ Dedicated IPs (no sharing with others)
- ✅ Excellent for authentication flows
- ❌ Most expensive option
- ⚠️ Limited provider choices

**Provider Options:**
| Provider | Price/Month | IPs Included | Speed | Quality |
|----------|-------------|--------------|-------|---------|
| Bright Data ISP | $500+/mo | Flexible | Fast | Excellent |
| Oxylabs ISP | Custom pricing | Dedicated | Fast | Enterprise-grade |

**Use Case:** Mission-critical authenticated sessions, high-volume API usage

---

## 💡 Recommendation: Hybrid Architecture

### **Best Practice Strategy:**

```javascript
// 9router proxy routing strategy

PROXY_ROUTES = {
  // Default: residential for general API calls
  default: "residential-pool",
  
  // High-priority/sensitive: mobile proxies
  "/v1/chat/completions": "mobile-tier",
  "/api/auth/*": "isp-dedicated",
  
  // Low-priority/scraping: datacenter
  "/healthz": "datacenter-fast",
  "/telemetry/*": "datacenter-economy"
}

// Automatic failover
FAILOVER_PRIORITY = [
  "isp-dedicated",      // Primary (most trusted)
  "mobile-tier",        // Secondary (high success)
  "residential-pool",   // Tertiary (good balance)
  "datacenter-fast"     // Fallback (speed over trust)
]
```

**Why Hybrid?**
1. **Cost optimization**: Use cheapest appropriate tier
2. **Reliability**: Failover when one pool exhausted
3. **Performance**: Match proxy type to task requirements
4. **Risk mitigation**: Spread across multiple providers

---

## 🏗️ Kiến Trúc Hệ Thống Đề Xuất

### **Component Overview:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    9router Core                                 │
│                        (.20129)                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Hedge Gateway (existing)                                │ │
│  │  ✓ Account rotation                                      │ │
│  │  ✓ Retry logic                                           │ │
│  │  ✓ Circuit breakers                                      │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                              ↓ x-connection-id headers
┌─────────────────────────────────────────────────────────────────┐
│              Proxy Orchestration Layer                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Proxy Manager (:20133)                                  │ │
│  │  ├─ Pool health monitoring                               │ │
│  │  ├─ Automatic failover                                   │ │
│  │  ├─ Geographic distribution                              │ │
│  │  └─ Usage-based routing                                  │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐ │
│  │ Residential  │   Datacenter │    Mobile    │     ISP      │ │
│  │   Pool 1     │    Pool 2    │    Pool 3    │    Pool 4    │ │
│  │ :20130       │   :20131     │   :20132     │   :20133     │ │
│  │ ~95% succ    │ ~90% succ    │ ~99% succ    │ 99.9% succ   │ │
│  └──────────────┴──────────────┴──────────────┴──────────────┘ │
└───────────────────────────────────────────────────────────────┘
                              ↓
                      [External Upstreams]
               qoder.sh | deepseek.ai | muse.ai
```

---

## 🔧 Implementation Plan

### **Phase P0: Research & Vendor Selection** ✅ IN PROGRESS

#### **Tasks:**
- [ ] Compare top 3 providers per category
- [ ] Request trials/quoting
- [ ] Verify API availability for programmatic control
- [ ] Check geographic coverage matching 9router needs
- [ ] Review SLA terms and uptime guarantees

#### **Deliverables:**
1. Comparison matrix spreadsheet
2. Trial credentials for evaluation
3. Pricing calculator (cost/benefit analysis)

---

### **Phase P1: Prototype Implementation** 

#### **Architecture Design:**

```javascript
// proxy-manager.cjs - Main orchestration module

const http = require("http");
const EventEmitter = require("events");

class ProxyManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.pools = {};
    this.healthMonitor = null;
    this.usageTracker = {};
    
    // Initialize pools
    Object.entries(config.pools).forEach(([name, poolConfig]) => {
      this.pools[name] = new ProxyPool(name, poolConfig);
    });
  }
  
  async selectProxy(requestContext) {
    const priorityOrder = requestContext.priority || ["isp", "mobile", "residential", "datacenter"];
    
    for (const name of priorityOrder) {
      const pool = this.pools[name];
      if (pool && await pool.isHealthy()) {
        return pool.getNextProxy();
      }
    }
    
    throw new Error("No healthy proxies available");
  }
  
  async recordResult(proxyUrl, success, latencyMs) {
    const poolName = this.getPoolNameFromUrl(proxyUrl);
    if (this.usageTracker[poolName]) {
      this.usageTracker[poolName].successes += success ? 1 : 0;
      this.usageTracker[poolName].latencies.push(latencyMs);
      
      // Auto-rebalance based on performance
      this.rebalancePools();
    }
  }
}
```

#### **Implementation Tasks:**
- [ ] Build ProxyPool class (handles individual provider connections)
- [ ] Implement health checking (HTTP ping + response validation)
- [ ] Create load balancer logic (round-robin vs weighted)
- [ ] Add circuit breaker pattern for failed pools
- [ ] Implement usage-based automatic failover

#### **Testing Strategy:**
```bash
# 1. Unit tests
node test/proxy-manager.unit.js

# 2. Integration tests with mock upstreams
node test/proxy-manager.integration.js

# 3. Load testing (simulate 1000 req/min)
NODE_ENV=test npm run load-test
```

---

### **Phase P2: Integration with 9router**

#### **Modification Points:**

**File 1: `9r-hedge-gateway.js`**

Add proxy passthrough header:
```javascript
// Line ~268: Pass selected proxy to upstream
up.on("error", (e) => finish({ promoted, why: "up-err", text: (e.cause?.message || e.message || "").slice(0, 300) }));
up.setTimeout(IDLE_MS, () => { up.destroy(); finish({ promoted, why: "socket-idle-timeout", text: buf.slice(-400) }); }, IDLE_MS);
shared.sockets.push(up);
up.end(bodyBuf);

// BEFORE making request, inject proxy info
const selectedProxy = await proxyManager.selectProxy({
  model: shared.model,
  priority: getProxyPriority(shared.model), // Custom routing logic
  session_id: bodyBuf.sessionId // From request context
});

headers["X-Proxy-Selected"] = selectedProxy.url;
headers["X-Proxy-Pool"] = selectedProxy.poolName;
```

**File 2: New file `proxy-routing.js`**

```javascript
// Intelligent proxy selection based on model requirements

function getProxyPriority(model) {
  const modelInfo = getModelInfo(model);
  
  // Critical models get premium proxies
  if (model.includes("qfmodel") || model.includes("deepseek")) {
    return ["isp-dedicated", "mobile-tier", "residential-pool"];
  }
  
  // Standard models use balanced approach
  if (model.includes("muse")) {
    return ["residential-pool", "datacenter-fast"];
  }
  
  // Generic fallback
  return ["residential-pool", "datacenter-fast"];
}
```

**Integration Tasks:**
- [ ] Modify hedge gateway to accept proxy configuration
- [ ] Inject proxy selection before making upstream requests
- [ ] Update error handling to capture proxy failures
- [ ] Add telemetry for proxy performance tracking
- [ ] Test end-to-end flow with failing proxies

---

### **Phase P3: Operational Excellence**

#### **Monitoring Dashboard:**

Create real-time dashboard showing:
- Proxy pool health (% success rate rolling window)
- Latency percentiles (p50, p95, p99)
- Cost per GB consumed
- Geographic distribution heatmap
- Failover events logged

#### **Alerting Rules:**

```yaml
alerts:
  - name: "High Failure Rate"
    condition: "failure_rate > 10% for any pool over 5m"
    action: "auto-failover + slack notification"
    
  - name: "Slow Response Times"
    condition: "p95_latency > 2s for 3 consecutive minutes"
    action: "reduce traffic to affected pool"
    
  - name: "Budget Warning"
    condition: "daily_cost > budget * 0.8"
    action: "alert finance + suggest optimization"
```

#### **Configuration Management:**

```yaml
# proxy-config.yaml
pools:
  residential:
    provider: illuminated
    auth_method: header
    endpoints:
      - https://api.illuminated.com/proxy
    limits:
      max_concurrent: 100
      min_bandwidth: 5mbps
      max_latency_ms: 500
  
  isp:
    provider: bright_data
    auth_method: ip_pool
    ip_pools:
      - us_residential_static
      - eu_residential_static
    dedicated_ips: true
    
  mobile:
    provider: smartproxy_mobile
    regions:
      - us_east_1
      - eu_west_1
    carrier_filter: verizon,vodafone,tmobile
```

---

## 💰 Cost Analysis & ROI

### **Estimated Costs (Monthly):**

| Scenario | Datacenter | Residential | ISP | Total |
|----------|------------|-------------|-----|-------|
| **Basic** (low volume) | $50 | $100 | $0 | **$150/mo** |
| **Standard** (medium) | $100 | $500 | $300 | **$900/mo** |
| **Premium** (high volume) | $200 | $1500 | $1000 | **$2,700/mo** |

**ROI Justification:**
- Avoid IP bans: Save potential $5k+ in service interruptions
- Improve success rates: +20% conversion rate on API calls
- Enable geographic diversity: Access regional models
- Better performance: Faster response times with optimal proxy selection

---

## 🛡️ Security Considerations

### **Credential Protection:**

⚠️ **CRITICAL:** Never hardcode proxy credentials!

```javascript
// BAD ❌
const PROVIDER_API_KEY = "sk-xxx-private-key";

// GOOD ✅
const PROVIDER_API_KEY = process.env.PROXY_PROVIDER_KEY;

// Environment setup:
export PROXY_PROVIDER_KEY="sk-live-xxx" 
# Store in secure vault: AWS Secrets Manager / HashiCorp Vault
```

### **Network Isolation:**

```bash
# Run proxy manager in isolated container/network
docker run --network proxy-network \
  --cap-drop ALL \
  --cap-add NET_ADMIN \
  proxy-manager
```

### **Data Privacy:**

- No logging of proxied content (only metadata)
- Automatic log rotation (7-day retention max)
- Encrypted storage for connection logs
- Regular security audits

---

## 🚀 Deployment Strategies

### **Option A: Sidecar Pattern**

Deploy proxy manager as sidecar next to 9router:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: 9router-with-proxy
spec:
  containers:
  - name: 9router
    image: 9router:latest
    ports:
    - containerPort: 20129
  - name: proxy-manager
    image: proxy-manager:v1.0
    ports:
    - containerPort: 20133
    env:
    - name: CONFIG_PATH
      value: "/etc/proxy/config.yaml"
    volumeMounts:
    - name: config-vol
      mountPath: /etc/proxy
  volumes:
  - name: config-vol
    secret:
      secretName: proxy-secrets
```

**Pros:**
- Tight coupling with 9router lifecycle
- Low latency internal communication
- Shared resource池

**Cons:**
- Both scale together
- Single pod failure affects both

---

### **Option B: Standalone Service**

Run proxy manager independently:

```bash
# Deploy via Kubernetes service
kubectl apply -f proxy-manager-deployment.yaml
kubectl expose svc/proxy-manager --type=ClusterIP --port=20133

# Point 9router to external endpoint
export PROXY_MANAGER_URL=http://proxy-manager:20133
node 9r-hedge-gateway.js
```

**Pros:**
- Independent scaling
- Can serve multiple clients
- Easier maintenance updates

**Cons:**
- Network latency added
- Need to manage cross-service dependencies

---

## 📋 Testing Checklist

### **Pre-Launch Validation:**

- [ ] Unit tests: All proxy pool classes pass
- [ ] Integration tests: End-to-end flow works
- [ ] Failover tests: Automatic switchover on pool failure
- [ ] Load tests: Handles peak traffic (>10K req/min)
- [ ] Security audit: Credentials properly secured
- [ ] Monitoring: Dashboards and alerts configured
- [ ] Documentation: Runbook for common scenarios

### **Post-Deployment Verification:**

```bash
# 1. Health check
curl http://localhost:20133/healthz

# Expected output:
{
  "ok": true,
  "pools": {
    "residential": {"healthy": true, "active_proxies": 47, "avg_latency_ms": 234},
    "isp": {"healthy": true, "active_proxies": 12, "avg_latency_ms": 187},
    ...
  },
  "total_success_rate": 97.8
}

# 2. Throughput test
wrk -t12 -c400 -d30s http://localhost:20129/v1/chat/completions

# 3. Error rate monitoring
watch -n1 'curl -s http://localhost:20129/healthz | jq ".stats.byModel[] | select(.fail > 0)"'
```

---

## 🔮 Future Enhancements

### **Phase P4+: Advanced Features**

1. **Machine Learning Routing:**
   - Predict best proxy based on historical success patterns
   - Dynamic cost/quality optimization
   - Anomaly detection for unusual proxy behavior

2. **Multi-Provider Aggregation:**
   - Aggregate from multiple providers simultaneously
   - Increase redundancy and failover options
   - Better negotiation power with vendors

3. **Edge Location Optimization:**
   - Route through geographically closer proxies
   - Reduce latency for time-sensitive operations
   - Compliance with data sovereignty requirements

4. **Protocol Buffers Support:**
   - Native protocol buffer support alongside HTTP
   - Reduce serialization overhead
   - Better compatibility with proto-based services

---

## 📝 Summary & Next Steps

### **Immediate Actions Required:**

1. **Vendor Selection (Week 1):**
   - Request trials from Bright Data, Illuminated, Smartproxy
   - Evaluate success rates with our specific use cases
   - Negotiate pricing for committed volumes

2. **Prototype Build (Week 2-3):**
   - Implement basic ProxyManager class
   - Connect to one residential pool for testing
   - Modify 9router to route through prototype

3. **Integration Testing (Week 4):**
   - Run against staging environment
   - Measure success rate improvements
   - Validate failover mechanisms

4. **Production Rollout (Week 5+):**
   - Gradual traffic ramp-up (10% → 50% → 100%)
   - Monitor metrics closely
   - Prepare rollback plan

### **Risks & Mitigations:**

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Provider downtime | Medium | High | Multi-provider failover |
| Cost overruns | High | Medium | Budget caps + alerts |
| Performance degradation | Low | High | A/B testing with/without proxy |
| Integration complexity | High | Medium | Phased rollout approach |

---

## ✅ Deliverables Checklist

By end of implementation:

- [ ] Proxy management system operational
- [ ] Documented integration with 9router
- [ ] Cost tracking and reporting in place
- [ ] Monitoring dashboards live
- [ ] Automated alerting configured
- [ ] Runbook for operations team
- [ ] Post-mortem template ready
- [ ] Rollback procedures documented

---

**End of Plan**

For detailed technical specs, see companion documents:
- `proxy-manager-design.md` - Class architecture
- `vendor-comparison.xlsx` - Provider comparison spreadsheet
- `deployment-guide.md` - Step-by-step deployment instructions
