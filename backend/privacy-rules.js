/**
 * Per-site Privacy Control
 *
 * Manages "AI invisible" site list and incognito mode.
 * When a site is invisible: no page content extraction, no browsing memory, no AI context.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'privacy-rules.json');

// Default invisible domains (banking, medical, government)
const DEFAULT_INVISIBLE = [
  // Banking
  'bank.com', '*.bank.com',
  'chase.com', '*.chase.com',
  'wellsfargo.com', '*.wellsfargo.com',
  'citi.com', '*.citi.com',
  'hsbc.com', '*.hsbc.com',
  'icbc.com.cn', '*.icbc.com.cn',
  'ccb.com', '*.ccb.com',
  'boc.cn', '*.boc.cn',
  'abchina.com', '*.abchina.com',
  'cmbchina.com', '*.cmbchina.com',
  // Payment
  'paypal.com', '*.paypal.com',
  'stripe.com', '*.stripe.com',
  'alipay.com', '*.alipay.com',
  // Medical
  'myhealth.va.gov',
  'mychart.com', '*.mychart.com',
  'patient.info',
  // Government
  '*.gov', '*.gov.cn', '*.gov.hk',
];

let _config = null;

function loadConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    _config = {
      invisible: [...DEFAULT_INVISIBLE],
      incognito: false,
    };
    saveConfig();
  }
  return _config;
}

function saveConfig() {
  if (!_config) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

/**
 * Check if a URL matches any pattern in the invisible list.
 * Supports exact domain match and wildcard *.domain.
 */
function matchesDomain(hostname, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }
  return hostname === pattern;
}

/**
 * Check if a URL should be AI-invisible.
 */
function isInvisible(url) {
  const config = loadConfig();
  if (config.incognito) return true;
  try {
    const hostname = new URL(url).hostname;
    return config.invisible.some(p => matchesDomain(hostname, p));
  } catch {
    return false;
  }
}

/**
 * Add a domain to the invisible list.
 */
function addInvisible(domain) {
  const config = loadConfig();
  if (!config.invisible.includes(domain)) {
    config.invisible.push(domain);
    saveConfig();
  }
}

/**
 * Remove a domain from the invisible list.
 */
function removeInvisible(domain) {
  const config = loadConfig();
  config.invisible = config.invisible.filter(d => d !== domain);
  saveConfig();
}

/**
 * Get the full invisible list.
 */
function getInvisibleList() {
  return loadConfig().invisible;
}

/**
 * Toggle incognito mode.
 */
function setIncognito(enabled) {
  const config = loadConfig();
  config.incognito = !!enabled;
  saveConfig();
  return config.incognito;
}

/**
 * Get incognito state.
 */
function isIncognito() {
  return loadConfig().incognito;
}

module.exports = {
  isInvisible,
  addInvisible,
  removeInvisible,
  getInvisibleList,
  setIncognito,
  isIncognito,
};
