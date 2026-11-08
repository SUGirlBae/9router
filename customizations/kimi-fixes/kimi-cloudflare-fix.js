/**
 * Kimi Cloudflare Bypass Patch for 9router
 * Fixes HTTP 503 [kimi/k3] [403] Cloudflare "Attention Required!" errors
 */

// Enhanced User-Agent và headers giống trình duyệt thật
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://kimi.moonshot.cn/',
  'Origin': 'https://kimi.moonshot.cn',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

module.exports = {
  name: 'kimi-cloudflare-bypass',
  version: '1.0.0',
  description: 'Bypass Cloudflare WAF for Kimi OAuth provider',
  
  // Patch function to intercept requests
  interceptRequest(config) {
    if (config.url?.includes('kimi') || config.providerId === 'kimi/k3') {
      // Merge browser-like headers
      config.headers = {
        ...BROWSER_HEADERS,
        ...config.headers, // Keep existing cookies/session tokens
      };
    }
    return config;
  },
  
  // Handle Cloudflare challenge responses
  async handleResponse(response) {
    if (response.status === 403 && response.data?.includes('Cloudflare')) {
      console.warn('[Kimi Patch] Cloudflare detected, retrying with enhanced headers...');
      // Retry with additional browser fingerprinting
      return this.retryWithBrowserFingerprint(response.config);
    }
    return response;
  },
  
  // Retry strategy với exponential backoff
  async retryWithBrowserFingerprint(config, attempt = 1) {
    if (attempt > 3) {
      throw new Error('Max retries exceeded. Cloudflare blocking persistently.');
    }
    
    const enhancedHeaders = {
      ...BROWSER_HEADERS,
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };
    
    // Add delay giữa các attempts
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    
    return fetch(config.url, {
      ...config,
      headers: { ...config.headers, ...enhancedHeaders },
    });
  },
};