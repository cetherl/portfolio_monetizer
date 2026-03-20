import React, { useState, useEffect, useCallback } from 'react';
import { TrendingUp, TrendingDown, AlertCircle, DollarSign, Upload, Plus, X, Bell, Target, Calendar, Percent, Edit2, RefreshCw, ChevronDown, ChevronUp, Zap, Check } from 'lucide-react';

// Storage adapter - uses localStorage for deployed app
const storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(key);
      return value ? { value } : null;
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
      return { key, value };
    } catch (e) {
      return null;
    }
  }
};

// ─── Schwab API Configuration ──────────────────────────────────────────────
const SCHWAB_CONFIG = {
  clientId: 'FFaYl3XSHY9ZNYCq0sD51YShXGXNETLfcVcFAZGLn93Q9Cum',
  clientSecret: 'WSYAZDU7mTVWl82wWc368tQJ5vivNZZPOHqQzw0y4VL1NkCLAgn6USboabW0OfEA',
  redirectUri: window.location.origin, // Automatically uses your deployed domain (e.g., https://your-app.vercel.app)
  authUrl: 'https://api.schwabapi.com/v1/oauth/authorize',
  tokenUrl: 'https://api.schwabapi.com/v1/oauth/token',
  quotesUrl: 'https://api.schwabapi.com/marketdata/v1/quotes',
  optionsUrl: 'https://api.schwabapi.com/marketdata/v1/chains'
};

// ─── Black-Scholes (fallback only) ─────────────────────────────────────────
const norm = (x) => {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1/(1+p*Math.abs(x)/Math.sqrt(2));
  const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x/2);
  return 0.5*(1+sign*y);
};

const bsCallPrice = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S/K) + (r + sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return S*norm(d1) - K*Math.exp(-r*T)*norm(d2);
};

const calcOptionData = (stockPrice, strike, daysToExp, ivEstimate = 0.45) => {
  const T = daysToExp / 365;
  const r = 0.05;
  const premium = bsCallPrice(stockPrice, strike, T, r, ivEstimate);
  const d1 = (Math.log(stockPrice/strike) + (r + ivEstimate*ivEstimate/2)*T) / (ivEstimate*Math.sqrt(T));
  const delta = norm(d1);
  const probOTM = 1 - delta;
  return { premium: Math.max(0.01, premium), delta, probOTM };
};

const getExpirations = () => {
  const expirations = [];
  const today = new Date();
  for (let monthOffset = 0; monthOffset <= 6; monthOffset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    let fridays = 0;
    while (fridays < 3) {
      if (d.getDay() === 5) fridays++;
      if (fridays < 3) d.setDate(d.getDate() + 1);
    }
    const dte = Math.ceil((d - today) / (1000*60*60*24));
    if (dte > 0) {
      expirations.push({
        date: d.toISOString().split('T')[0],
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        dte
      });
    }
  }
  return expirations;
};

const EXPIRATIONS = getExpirations();

const PortfolioMonetizer = () => {
  const [positions, setPositions] = useState([]);
  const [optionPositions, setOptionPositions] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [priceLoading, setPriceLoading] = useState(false);
  const [marketData, setMarketData] = useState({});
  const [selectedTimeframe, setSelectedTimeframe] = useState('monthly');
  
  // Schwab OAuth
  const [schwabToken, setSchwabToken] = useState(null);
  const [schwabRefreshToken, setSchwabRefreshToken] = useState(null);
  const [schwabConnected, setSchwabConnected] = useState(false);
  const [schwabStatus, setSchwabStatus] = useState('');
  
  // Sorting state
  const [stockSort, setStockSort] = useState({ column: null, direction: 'asc' });
  const [oppSort, setOppSort] = useState({ column: 'annualizedReturn', direction: 'desc' });

  // Modal states
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [showManualAuth, setShowManualAuth] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [manualPriceSymbol, setManualPriceSymbol] = useState('');
  const [manualPriceValue, setManualPriceValue] = useState('');

  // Form states
  const [stockForm, setStockForm] = useState({ symbol: '', shares: '', costBasis: '' });
  const [optionForm, setOptionForm] = useState({ symbol: '', type: 'call', position: 'short', strike: '', expiration: '', quantity: '', premium: '' });

  useEffect(() => { 
    loadAll();
    loadSchwabTokens();
    checkForAuthCode();
  }, []);

  useEffect(() => {
    if (positions.length > 0) {
      fetchPrices();
      const interval = setInterval(fetchPrices, 60000);
      return () => clearInterval(interval);
    }
  }, [positions.length, schwabToken]);

  useEffect(() => {
    if (Object.keys(marketData).length > 0) scanOpportunities();
  }, [marketData, selectedTimeframe]);

  // ─── Schwab OAuth Flow ─────────────────────────────────────────────────────
  const loadSchwabTokens = async () => {
    try {
      const tokenResult = await storage.get('schwab-access-token');
      const refreshResult = await storage.get('schwab-refresh-token');
      if (tokenResult && refreshResult) {
        setSchwabToken(tokenResult.value);
        setSchwabRefreshToken(refreshResult.value);
        setSchwabConnected(true);
        setSchwabStatus('Connected to Schwab');
      }
    } catch(e) {
      console.log('No saved Schwab tokens');
    }
  };

  const checkForAuthCode = () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      exchangeCodeForToken(code);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  const connectSchwab = () => {
    console.log('Connect to Schwab clicked');
    try {
      const state = Math.random().toString(36).substring(7);
      const authUrl = `${SCHWAB_CONFIG.authUrl}?client_id=${SCHWAB_CONFIG.clientId}&redirect_uri=${encodeURIComponent(SCHWAB_CONFIG.redirectUri)}&response_type=code&state=${state}`;
      console.log('Auth URL:', authUrl);
      
      // Show manual auth modal with URL
      setShowManualAuth(true);
      setSchwabStatus(authUrl);
    } catch (error) {
      console.error('Connect error:', error);
      setSchwabStatus(`Error: ${error.message}`);
    }
  };

  const submitAuthCode = () => {
    if (authCode.trim()) {
      exchangeCodeForToken(authCode.trim());
      setShowManualAuth(false);
      setAuthCode('');
    }
  };

  const exchangeCodeForToken = async (code) => {
    setSchwabStatus('Exchanging authorization code...');
    try {
      const credentials = btoa(`${SCHWAB_CONFIG.clientId}:${SCHWAB_CONFIG.clientSecret}`);
      const response = await fetch(SCHWAB_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: SCHWAB_CONFIG.redirectUri
        })
      });

      if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);

      const data = await response.json();
      await storage.set('schwab-access-token', data.access_token);
      await storage.set('schwab-refresh-token', data.refresh_token);
      setSchwabToken(data.access_token);
      setSchwabRefreshToken(data.refresh_token);
      setSchwabConnected(true);
      setSchwabStatus('✓ Connected to Schwab!');
      
      if (positions.length > 0) fetchPrices();
    } catch(error) {
      console.error('Token exchange error:', error);
      setSchwabStatus(`Connection failed: ${error.message}`);
    }
  };

  const refreshSchwabToken = async () => {
    if (!schwabRefreshToken) return false;
    
    try {
      const credentials = btoa(`${SCHWAB_CONFIG.clientId}:${SCHWAB_CONFIG.clientSecret}`);
      const response = await fetch(SCHWAB_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: schwabRefreshToken
        })
      });

      if (!response.ok) throw new Error('Token refresh failed');

      const data = await response.json();
      await storage.set('schwab-access-token', data.access_token);
      if (data.refresh_token) {
        await storage.set('schwab-refresh-token', data.refresh_token);
        setSchwabRefreshToken(data.refresh_token);
      }
      setSchwabToken(data.access_token);
      return true;
    } catch(error) {
      console.error('Token refresh error:', error);
      setSchwabConnected(false);
      setSchwabStatus('Token expired - please reconnect');
      return false;
    }
  };

  const disconnectSchwab = async () => {
    await storage.set('schwab-access-token', '');
    await storage.set('schwab-refresh-token', '');
    setSchwabToken(null);
    setSchwabRefreshToken(null);
    setSchwabConnected(false);
    setSchwabStatus('');
  };

  // ─── Storage ───────────────────────────────────────────────────────────────
  const loadAll = async () => {
    try {
      const r1 = await storage.get('portfolio-positions');
      if (r1) {
        const valid = JSON.parse(r1.value).filter(p => p?.symbol && p?.shares && p?.costBasis);
        setPositions(valid);
      }
    } catch(e) {}
    try {
      const r2 = await storage.get('portfolio-option-positions');
      if (r2) setOptionPositions(JSON.parse(r2.value));
    } catch(e) {}
  };

  const savePositions = async (list) => {
    await storage.set('portfolio-positions', JSON.stringify(list));
    setPositions(list);
  };

  const saveOptions = async (list) => {
    await storage.set('portfolio-option-positions', JSON.stringify(list));
    setOptionPositions(list);
  };

  // ─── Price fetching ────────────────────────────────────────────────────────
  const fetchPrices = async () => {
    if (positions.length === 0) return;
    setPriceLoading(true);
    
    if (schwabToken) {
      await fetchPricesFromSchwab();
    } else {
      await fetchPricesFromClaude();
    }
    
    setPriceLoading(false);
  };

  const fetchPricesFromSchwab = async () => {
    const symbols = positions.map(p => p.symbol).join(',');
    try {
      const response = await fetch(`${SCHWAB_CONFIG.quotesUrl}?symbols=${symbols}&fields=quote`, {
        headers: {
          'Authorization': `Bearer ${schwabToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.status === 401) {
        const refreshed = await refreshSchwabToken();
        if (refreshed) return fetchPricesFromSchwab();
        return;
      }

      if (!response.ok) throw new Error(`Schwab API error: ${response.status}`);

      const data = await response.json();
      const newData = {};

      positions.forEach(pos => {
        const quote = data[pos.symbol]?.quote;
        if (quote) {
          const price = quote.lastPrice || quote.mark || quote.closePrice;
          const prevClose = quote.closePrice || price;
          const change = price - prevClose;
          const changePercent = (change / prevClose) * 100;

          newData[pos.symbol] = {
            price,
            change,
            changePercent,
            lastUpdated: new Date().toISOString(),
            bidSize: quote.bidSize,
            askSize: quote.askSize,
            volume: quote.totalVolume
          };
          storage.set(`price-${pos.symbol}`, JSON.stringify(newData[pos.symbol]));
        } else {
          newData[pos.symbol] = { price: pos.costBasis, change: 0, changePercent: 0 };
        }
      });

      setMarketData(newData);
      setSchwabStatus('✓ Prices updated from Schwab');
    } catch(error) {
      console.error('Schwab price fetch error:', error);
      setSchwabStatus(`Error: ${error.message}`);
      await fetchPricesFromClaude();
    }
  };

  const fetchPricesFromClaude = async () => {
    const symbols = positions.map(p => p.symbol).join(', ');
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Get the most recent stock prices for: ${symbols}. Today is ${today}. For each ticker, find the current price if market is open, or today's closing price if market is closed. Search for the LATEST data. Return ONLY a JSON object (no other text, no markdown): {"META": {"price": 643.22, "change": 5.10, "changePercent": 0.80}, "AAPL": {"price": 182.50, "change": 1.23, "changePercent": 0.68}}`
          }],
          tools: [{ "type": "web_search_20250305", "name": "web_search" }]
        })
      });
      const result = await response.json();
      let priceMap = {};
      for (const block of (result.content || [])) {
        if (block.type === 'text') {
          try {
            const clean = block.text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            priceMap = JSON.parse(clean);
            break;
          } catch(e) {}
        }
      }
      if (Object.keys(priceMap).length > 0) {
        const newData = {};
        positions.forEach(pos => {
          const pd = priceMap[pos.symbol];
          if (pd?.price) {
            newData[pos.symbol] = { price: pd.price, change: pd.change || 0, changePercent: pd.changePercent || 0, lastUpdated: new Date().toISOString() };
            storage.set(`price-${pos.symbol}`, JSON.stringify(newData[pos.symbol]));
          } else {
            newData[pos.symbol] = { price: pos.costBasis, change: 0, changePercent: 0 };
          }
        });
        setMarketData(newData);
      }
    } catch(e) {
      console.error('Claude price fetch error:', e);
      const cached = {};
      for (const pos of positions) {
        try {
          const r = await storage.get(`price-${pos.symbol}`);
          cached[pos.symbol] = r ? JSON.parse(r.value) : { price: pos.costBasis, change: 0, changePercent: 0 };
        } catch(_) { cached[pos.symbol] = { price: pos.costBasis, change: 0, changePercent: 0 }; }
      }
      setMarketData(cached);
    }
  };

  // ─── Fetch Options Chain from Schwab ───────────────────────────────────────
  const fetchOptionsChain = async (symbol) => {
    if (!schwabToken) return null;
    
    try {
      const response = await fetch(
        `${SCHWAB_CONFIG.optionsUrl}?symbol=${symbol}&contractType=CALL&includeQuotes=true`,
        {
          headers: {
            'Authorization': `Bearer ${schwabToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (response.status === 401) {
        const refreshed = await refreshSchwabToken();
        if (refreshed) return fetchOptionsChain(symbol);
        return null;
      }

      if (!response.ok) return null;
      return await response.json();
    } catch(error) {
      console.error('Options chain fetch error:', error);
      return null;
    }
  };

  // ─── Opportunity Scanner ───────────────────────────────────────────────────
  const scanOpportunities = useCallback(async () => {
    const opps = [];

    for (const pos of positions) {
      if (!pos.symbol || !pos.shares || !pos.costBasis) continue;
      const lots = Math.floor(pos.shares / 100);
      if (lots < 1) continue;
      const data = marketData[pos.symbol];
      if (!data?.price) continue;
      const S = data.price;

      let optionsData = null;
      if (schwabToken) {
        optionsData = await fetchOptionsChain(pos.symbol);
      }

      if (optionsData && optionsData.callExpDateMap) {
        const expirationMap = optionsData.callExpDateMap;
        
        for (const [expDateStr, strikes] of Object.entries(expirationMap)) {
          const expDate = expDateStr.split(':')[0];
          const dte = Math.ceil((new Date(expDate) - new Date()) / (1000*60*60*24));
          
          const targetDTE = selectedTimeframe === 'weekly' ? [5,12] : selectedTimeframe === 'monthly' ? [20,45] : [60,90];
          if (dte < targetDTE[0] || dte > targetDTE[1]) continue;

          for (const [strikeStr, contracts] of Object.entries(strikes)) {
            const contract = contracts[0];
            const K = parseFloat(strikeStr);
            
            if (K <= pos.costBasis) continue;
            if (K <= S * 1.03) continue;

            const bid = contract.bid || 0;
            const ask = contract.ask || 0;
            const mark = contract.mark || ((bid + ask) / 2);
            const premium = mark;
            
            if (premium < 0.01) continue;

            const annualizedReturn = (premium / S) * (365 / dte) * 100;
            if (annualizedReturn < 20) continue;

            const safetyMargin = ((K - S) / S) * 100;
            const totalPremium = premium * lots * 100;
            const breakeven = S - premium;
            
            const T = dte / 365;
            const r = 0.05;
            const sigma = contract.volatility || 0.45;
            const d_breakeven = (Math.log(S / breakeven) + (r - sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
            const probAboveBreakeven = norm(d_breakeven) * 100;

            const delta = contract.delta || 0.3;
            const probOTM = (1 - Math.abs(delta)) * 100;

            opps.push({
              id: `${pos.symbol}-${K}-${expDate}`,
              symbol: pos.symbol,
              strategyType: 'Covered Call',
              lots,
              currentPrice: S,
              costBasis: pos.costBasis,
              strike: K,
              expiration: expDate,
              expirationLabel: new Date(expDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
              dte,
              premium,
              bid,
              ask,
              totalPremium,
              annualizedReturn,
              safetyMargin,
              delta,
              probOTM,
              breakeven,
              probProfit: probAboveBreakeven,
              iv: contract.volatility ? (contract.volatility * 100).toFixed(1) + '%' : '--',
              volume: contract.totalVolume || 0,
              openInterest: contract.openInterest || 0,
              urgency: annualizedReturn >= 40 ? 'high' : annualizedReturn >= 30 ? 'medium' : 'low',
              note: `Sell ${lots} x ${pos.symbol} $${K}C ${new Date(expDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} @ $${premium.toFixed(2)} (bid: $${bid.toFixed(2)}, ask: $${ask.toFixed(2)})`
            });
          }
        }
      } else {
        const targetDTE = selectedTimeframe === 'weekly' ? [5,12] : selectedTimeframe === 'monthly' ? [20,45] : [60,90];
        const relevantExps = EXPIRATIONS.filter(e => e.dte >= targetDTE[0] && e.dte <= targetDTE[1]).slice(0, 2);

        relevantExps.forEach(exp => {
          const increment = S < 50 ? 2.5 : S < 200 ? 5 : 10;
          const minStrike = Math.ceil((S * 1.05) / increment) * increment;
          const maxStrike = Math.ceil((S * 1.20) / increment) * increment;

          for (let K = minStrike; K <= maxStrike; K += increment) {
            if (K <= pos.costBasis) continue;

            const { premium, delta, probOTM } = calcOptionData(S, K, exp.dte);
            const annualizedReturn = (premium / S) * (365 / exp.dte) * 100;

            if (annualizedReturn < 20) continue;

            const safetyMargin = ((K - S) / S) * 100;
            const totalPremium = premium * lots * 100;
            const breakeven = S - premium;
            
            const T = exp.dte / 365;
            const r = 0.05;
            const sigma = 0.45;
            const d_breakeven = (Math.log(S / breakeven) + (r - sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
            const probAboveBreakeven = norm(d_breakeven) * 100;

            opps.push({
              id: `${pos.symbol}-${K}-${exp.date}`,
              symbol: pos.symbol,
              strategyType: 'Covered Call',
              lots,
              currentPrice: S,
              costBasis: pos.costBasis,
              strike: K,
              expiration: exp.date,
              expirationLabel: exp.label,
              dte: exp.dte,
              premium,
              totalPremium,
              annualizedReturn,
              safetyMargin,
              delta,
              probOTM: probOTM * 100,
              breakeven,
              probProfit: probAboveBreakeven,
              iv: '--',
              volume: '--',
              openInterest: '--',
              urgency: annualizedReturn >= 40 ? 'high' : annualizedReturn >= 30 ? 'medium' : 'low',
              note: `Sell ${lots} x ${pos.symbol} $${K}C ${exp.label} @ ~$${premium.toFixed(2)}`
            });
          }
        });
      }
    }

    const seen = new Set();
    const unique = opps.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
    unique.sort((a, b) => b.annualizedReturn - a.annualizedReturn);

    setOpportunities(unique.slice(0, 20));

    const hotAlerts = unique.filter(o => o.annualizedReturn >= 40).slice(0, 3).map(o => ({
      id: o.id,
      message: `🔥 ${o.symbol} $${o.strike}C ${o.expirationLabel} — ${o.annualizedReturn.toFixed(1)}% annualized, collect $${o.totalPremium.toFixed(0)} total`
    }));
    setAlerts(hotAlerts);
  }, [positions, marketData, selectedTimeframe, schwabToken]);

  // ─── Stock CRUD ────────────────────────────────────────────────────────────
  const openAddStock = () => { setStockForm({ symbol: '', shares: '', costBasis: '' }); setEditTarget(null); setModal('addStock'); };
  const openEditStock = (pos) => { setStockForm({ symbol: pos.symbol, shares: pos.shares.toString(), costBasis: pos.costBasis.toString() }); setEditTarget(pos.id); setModal('editStock'); };

  const saveStock = () => {
    const { symbol, shares, costBasis } = stockForm;
    if (!symbol || !shares || !costBasis) return;
    const entry = { id: editTarget || Date.now(), symbol: symbol.toUpperCase().trim(), shares: parseInt(shares), costBasis: parseFloat(costBasis) };
    const updated = editTarget ? positions.map(p => p.id === editTarget ? entry : p) : [...positions, entry];
    savePositions(updated);
    setModal(null);
  };

  const openManualPrice = (symbol) => {
    setManualPriceSymbol(symbol);
    setManualPriceValue(marketData[symbol]?.price?.toString() || '');
    setModal('manualPrice');
  };

  const saveManualPrice = () => {
    if (!manualPriceSymbol || !manualPriceValue) return;
    const price = parseFloat(manualPriceValue);
    if (isNaN(price) || price <= 0) return;
    const updated = { ...marketData, [manualPriceSymbol]: { price, change: 0, changePercent: 0, lastUpdated: new Date().toISOString() }};
    setMarketData(updated);
    storage.set(`price-${manualPriceSymbol}`, JSON.stringify(updated[manualPriceSymbol]));
    setModal(null);
    setManualPriceSymbol('');
    setManualPriceValue('');
  };

  const removeStock = (id) => savePositions(positions.filter(p => p.id !== id));

  // ─── Option CRUD ───────────────────────────────────────────────────────────
  const openAddOption = () => { setOptionForm({ symbol: '', type: 'call', position: 'short', strike: '', expiration: '', quantity: '', premium: '' }); setEditTarget(null); setModal('addOption'); };
  const openEditOption = (opt) => { setOptionForm({ symbol: opt.symbol, type: opt.type, position: opt.position, strike: opt.strike.toString(), expiration: opt.expiration, quantity: opt.quantity.toString(), premium: opt.premium.toString() }); setEditTarget(opt.id); setModal('editOption'); };

  const saveOption = () => {
    const { symbol, type, position, strike, expiration, quantity, premium } = optionForm;
    if (!symbol || !strike || !expiration || !quantity || !premium) return;
    const entry = { id: editTarget || Date.now(), symbol: symbol.toUpperCase().trim(), type, position, strike: parseFloat(strike), expiration, quantity: parseInt(quantity), premium: parseFloat(premium) };
    const updated = editTarget ? optionPositions.map(o => o.id === editTarget ? entry : o) : [...optionPositions, entry];
    saveOptions(updated);
    setModal(null);
  };

  const removeOption = (id) => saveOptions(optionPositions.filter(o => o.id !== id));

  // ─── CSV Import ────────────────────────────────────────────────────────────
  const importCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split('\n').filter(l => l.trim());
      const start = lines[0]?.toLowerCase().includes('symbol') ? 1 : 0;
      const imported = [];
      for (let i = start; i < lines.length; i++) {
        const [symbol, shares, costBasis] = lines[i].split(',').map(s => s.trim());
        const ps = parseInt((shares || '').replace(/[^\d]/g, ''));
        const pc = parseFloat((costBasis || '').replace(/[^\d.]/g, ''));
        if (symbol && !isNaN(ps) && !isNaN(pc) && ps > 0 && pc > 0) {
          imported.push({ id: Date.now() + i, symbol: symbol.toUpperCase().replace(/[^A-Z]/g,''), shares: ps, costBasis: pc });
        }
      }
      if (imported.length > 0) savePositions([...positions, ...imported]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const downloadTemplate = () => {
    const csv = "Symbol,Shares,CostBasis\nAAPL,200,150.00\nMSFT,300,380.50\nTSLA,100,245.75";
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'portfolio-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  // ─── Sorting ───────────────────────────────────────────────────────────────
  const handleSort = (column) => {
    setStockSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getSortedPositions = () => {
    if (!stockSort.column) return positions;
    
    const sorted = [...positions].sort((a, b) => {
      let aVal, bVal;
      
      switch(stockSort.column) {
        case 'symbol': aVal = a.symbol; bVal = b.symbol; break;
        case 'shares': aVal = a.shares; bVal = b.shares; break;
        case 'lots': aVal = Math.floor(a.shares / 100); bVal = Math.floor(b.shares / 100); break;
        case 'costBasis': aVal = a.costBasis; bVal = b.costBasis; break;
        case 'currentPrice': aVal = marketData[a.symbol]?.price || a.costBasis; bVal = marketData[b.symbol]?.price || b.costBasis; break;
        case 'marketValue': aVal = (marketData[a.symbol]?.price || a.costBasis) * a.shares; bVal = (marketData[b.symbol]?.price || b.costBasis) * b.shares; break;
        case 'pnl': aVal = ((marketData[a.symbol]?.price || a.costBasis) - a.costBasis) * a.shares; bVal = ((marketData[b.symbol]?.price || b.costBasis) - b.costBasis) * b.shares; break;
        default: return 0;
      }
      
      if (typeof aVal === 'string') {
        return stockSort.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      
      return stockSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    return sorted;
  };

  const handleOppSort = (column) => {
    setOppSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getSortedOpportunities = () => {
    if (!oppSort.column) return opportunities;
    return [...opportunities].sort((a, b) => {
      let aVal, bVal;
      switch(oppSort.column) {
        case 'symbol': aVal = a.symbol; bVal = b.symbol; break;
        case 'currentPrice': aVal = a.currentPrice; bVal = b.currentPrice; break;
        case 'strike': aVal = a.strike; bVal = b.strike; break;
        case 'breakeven': aVal = a.breakeven; bVal = b.breakeven; break;
        case 'dte': aVal = a.dte; bVal = b.dte; break;
        case 'premium': aVal = a.premium; bVal = b.premium; break;
        case 'totalPremium': aVal = a.totalPremium; bVal = b.totalPremium; break;
        case 'annualizedReturn': aVal = a.annualizedReturn; bVal = b.annualizedReturn; break;
        case 'probProfit': aVal = a.probProfit; bVal = b.probProfit; break;
        default: return 0;
      }
      if (typeof aVal === 'string') return oppSort.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      return oppSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
  };

  // ─── Totals ────────────────────────────────────────────────────────────────
  const totalValue = positions.reduce((s, p) => s + (marketData[p.symbol]?.price || p.costBasis) * p.shares, 0);
  const totalPnL = positions.reduce((s, p) => s + ((marketData[p.symbol]?.price || p.costBasis) - p.costBasis) * p.shares, 0);

  // ─── Shared styles ─────────────────────────────────────────────────────────
  const inp = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500";
  const lbl = "block text-xs text-slate-400 mb-1";

  // ─── Modals ────────────────────────────────────────────────────────────────
  const StockModal = () => (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={() => setModal(null)}>
      <div className="bg-slate-900 rounded-xl border border-slate-700 p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4">{editTarget ? 'Edit' : 'Add'} Stock Position</h3>
        <div className="space-y-3">
          <div>
            <label className={lbl}>Symbol</label>
            <input 
              key="symbol-input"
              autoFocus
              className={inp} 
              value={stockForm.symbol} 
              onChange={e => {
                const newValue = e.target.value.toUpperCase();
                setStockForm(prev => ({...prev, symbol: newValue}));
              }} 
              placeholder="AAPL"
              onKeyDown={e => e.key === 'Enter' && saveStock()} 
            />
          </div>
          <div>
            <label className={lbl}>Shares</label>
            <input 
              key="shares-input"
              type="number" 
              className={inp} 
              value={stockForm.shares} 
              onChange={e => {
                setStockForm(prev => ({...prev, shares: e.target.value}));
              }} 
              placeholder="200"
              onKeyDown={e => e.key === 'Enter' && saveStock()} 
            />
          </div>
          <div>
            <label className={lbl}>Cost Basis (per share)</label>
            <input 
              key="costbasis-input"
              type="number" 
              step="0.01" 
              className={inp} 
              value={stockForm.costBasis} 
              onChange={e => {
                setStockForm(prev => ({...prev, costBasis: e.target.value}));
              }} 
              placeholder="150.00"
              onKeyDown={e => e.key === 'Enter' && saveStock()} 
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={saveStock} className="flex-1 bg-emerald-600 hover:bg-emerald-500 py-2 rounded-lg text-sm font-medium transition-colors">Save</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );

  const OptionModal = () => (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={() => setModal(null)}>
      <div className="bg-slate-900 rounded-xl border border-slate-700 p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4">{editTarget ? 'Edit' : 'Add'} Option Position</h3>
        <div className="space-y-3">
          <div>
            <label className={lbl}>Symbol</label>
            <input 
              key="opt-symbol"
              autoFocus
              className={inp} 
              value={optionForm.symbol} 
              onChange={e => {
                const newValue = e.target.value.toUpperCase();
                setOptionForm(prev => ({...prev, symbol: newValue}));
              }} 
              placeholder="AAPL"
              onKeyDown={e => e.key === 'Enter' && saveOption()} 
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={lbl}>Type</label>
              <select key="opt-type" className={inp} value={optionForm.type} onChange={e => setOptionForm(prev => ({...prev, type: e.target.value}))}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Position</label>
              <select key="opt-position" className={inp} value={optionForm.position} onChange={e => setOptionForm(prev => ({...prev, position: e.target.value}))}>
                <option value="short">Short (Sold)</option>
                <option value="long">Long (Bought)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={lbl}>Strike</label>
              <input 
                key="opt-strike"
                type="number" 
                step="0.50" 
                className={inp} 
                value={optionForm.strike} 
                onChange={e => setOptionForm(prev => ({...prev, strike: e.target.value}))} 
                placeholder="155.00"
                onKeyDown={e => e.key === 'Enter' && saveOption()} 
              />
            </div>
            <div>
              <label className={lbl}>Qty (contracts)</label>
              <input 
                key="opt-quantity"
                type="number" 
                className={inp} 
                value={optionForm.quantity} 
                onChange={e => setOptionForm(prev => ({...prev, quantity: e.target.value}))} 
                placeholder="2"
                onKeyDown={e => e.key === 'Enter' && saveOption()} 
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={lbl}>Expiration</label>
              <input 
                key="opt-expiration"
                type="date" 
                className={inp} 
                value={optionForm.expiration} 
                onChange={e => setOptionForm(prev => ({...prev, expiration: e.target.value}))}
              />
            </div>
            <div>
              <label className={lbl}>Premium / share</label>
              <input 
                key="opt-premium"
                type="number" 
                step="0.01" 
                className={inp} 
                value={optionForm.premium} 
                onChange={e => setOptionForm(prev => ({...prev, premium: e.target.value}))} 
                placeholder="2.50"
                onKeyDown={e => e.key === 'Enter' && saveOption()} 
              />
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={saveOption} className="flex-1 bg-blue-600 hover:bg-blue-500 py-2 rounded-lg text-sm font-medium transition-colors">Save</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );

  const ConfirmModal = ({ type }) => (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-slate-900 rounded-xl border border-red-500 p-6 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-3"><AlertCircle className="text-red-400" size={20} /><h3 className="text-lg font-bold text-red-400">Confirm Delete</h3></div>
        <p className="text-slate-300 mb-5 text-sm">Delete all {type === 'stocks' ? 'stock' : 'option'} positions? <span className="text-red-400 font-semibold">This cannot be undone.</span></p>
        <div className="flex gap-2">
          <button onClick={() => { type === 'stocks' ? (savePositions([]), setMarketData({}), setOpportunities([])) : saveOptions([]); setModal(null); }} className="flex-1 bg-red-600 hover:bg-red-500 py-2 rounded-lg text-sm font-medium">Yes, Delete All</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium">Cancel</button>
        </div>
      </div>
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100 p-4">

      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-emerald-400 via-green-300 to-teal-400 bg-clip-text text-transparent">
            Portfolio Monetizer
          </h1>
          <div className="flex flex-wrap gap-2">
            {schwabConnected ? (
              <button onClick={disconnectSchwab} className="px-3 py-2 bg-green-600/20 border border-green-500/30 hover:bg-green-600/30 rounded-lg text-sm flex items-center gap-1 text-green-300">
                <Check size={15}/> Schwab Connected
              </button>
            ) : (
              <button onClick={connectSchwab} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium flex items-center gap-1">
                <Zap size={15}/> Connect Schwab
              </button>
            )}
            <button onClick={downloadTemplate} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm border border-slate-700 flex items-center gap-1">📄 Template</button>
            <label className="cursor-pointer px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm border border-slate-700 flex items-center gap-1">
              <Upload size={15}/> Import <input type="file" accept=".csv" onChange={importCSV} className="hidden"/>
            </label>
            <button onClick={openAddStock} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium flex items-center gap-1"><Plus size={15}/> Stock</button>
            <button onClick={openAddOption} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium flex items-center gap-1"><Plus size={15}/> Option</button>
            <button onClick={fetchPrices} disabled={priceLoading} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm border border-slate-600 flex items-center gap-1 disabled:opacity-50">
              <RefreshCw size={15} className={priceLoading ? 'animate-spin' : ''}/> Refresh
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-slate-400">Maximize premium · Protect shares</p>
          {schwabStatus && <span className="text-xs text-slate-500">· {schwabStatus}</span>}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="max-w-7xl mx-auto mb-6 grid grid-cols-3 gap-4">
        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700">
          <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><DollarSign size={12}/> Portfolio Value</div>
          <div className="text-2xl font-bold">${totalValue.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>
        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700">
          <div className="text-xs text-slate-400 mb-1 flex items-center gap-1">{totalPnL >= 0 ? <TrendingUp size={12}/> : <TrendingDown size={12}/>} Unrealized P&L</div>
          <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
          </div>
        </div>
        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700">
          <div className="text-xs text-slate-400 mb-1 flex items-center gap-1"><Target size={12}/> Opportunities</div>
          <div className="text-2xl font-bold text-amber-400">{opportunities.length}</div>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="max-w-7xl mx-auto mb-6 bg-amber-900/20 border border-amber-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><Bell className="text-amber-400" size={16}/><span className="font-semibold text-amber-300 text-sm">Hot Opportunities</span></div>
          {alerts.map((a, i) => <div key={i} className="text-sm text-slate-200 flex items-start gap-2 mt-1"><AlertCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0"/>{a.message}</div>)}
        </div>
      )}

      {/* Timeframe Selector */}
      <div className="max-w-7xl mx-auto mb-4 flex gap-2 items-center">
        {['weekly','monthly','quarterly'].map(tf => (
          <button key={tf} onClick={() => setSelectedTimeframe(tf)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1 ${selectedTimeframe===tf ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'}`}>
            <Calendar size={13}/> {tf.charAt(0).toUpperCase()+tf.slice(1)}
          </button>
        ))}
        <div className="ml-auto text-xs text-slate-500">
          {schwabConnected ? '✓ Using live Schwab data' : '⚠️ Using estimates - connect Schwab for real data'}
        </div>
      </div>

      {/* Opportunities Table */}
      <div className="max-w-7xl mx-auto mb-8">
        <h2 className="text-xl font-bold mb-3 flex items-center gap-2"><Target className="text-emerald-400" size={18}/> Premium Opportunities (≥20% Annualized)</h2>
        <div className="bg-slate-900/50 rounded-xl border border-slate-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 border-b border-slate-700">
              <tr>
                <th className="text-left p-3 text-slate-400 font-medium">Strategy</th>
                <th onClick={() => handleOppSort('symbol')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Symbol {oppSort.column === 'symbol' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Recommendation</th>
                <th onClick={() => handleOppSort('currentPrice')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Stock {oppSort.column === 'currentPrice' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('strike')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Strike {oppSort.column === 'strike' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('breakeven')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Breakeven {oppSort.column === 'breakeven' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Exp</th>
                <th onClick={() => handleOppSort('dte')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">DTE {oppSort.column === 'dte' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('premium')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Premium {oppSort.column === 'premium' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('totalPremium')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Total $ {oppSort.column === 'totalPremium' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('annualizedReturn')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Ann % {oppSort.column === 'annualizedReturn' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleOppSort('probProfit')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">PoP {oppSort.column === 'probProfit' && (oppSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                {schwabConnected && <th className="text-left p-3 text-slate-400 font-medium">IV</th>}
                {schwabConnected && <th className="text-left p-3 text-slate-400 font-medium">Vol/OI</th>}
              </tr>
            </thead>
            <tbody>
              {opportunities.length === 0 ? (
                <tr><td colSpan={schwabConnected ? "14" : "12"} className="text-center p-8 text-slate-400">{loading || priceLoading ? 'Loading...' : positions.length === 0 ? 'Add positions' : 'No opportunities ≥20%'}</td></tr>
              ) : getSortedOpportunities().map(opp => (
                <tr key={opp.id} className={`border-b border-slate-800 hover:bg-slate-800/40 ${opp.urgency==='high' ? 'bg-amber-950/10' : ''}`}>
                  <td className="p-3"><span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded text-xs font-semibold">{opp.strategyType}</span></td>
                  <td className="p-3 font-bold text-emerald-400">{opp.symbol}</td>
                  <td className="p-3 text-slate-300 text-xs max-w-xs">{opp.note}</td>
                  <td className="p-3 font-mono text-sm">${opp.currentPrice.toFixed(2)}</td>
                  <td className="p-3 font-mono text-emerald-400 font-bold">${opp.strike}</td>
                  <td className="p-3 font-mono text-blue-300 text-xs">
                    <div>${opp.breakeven.toFixed(2)}</div>
                    <div className="text-slate-500">{((opp.currentPrice - opp.breakeven) / opp.currentPrice * 100).toFixed(1)}%</div>
                  </td>
                  <td className="p-3 text-slate-300 text-xs">{opp.expirationLabel}</td>
                  <td className="p-3 text-slate-400">{opp.dte}d</td>
                  <td className="p-3 font-mono text-yellow-300 text-xs">{opp.bid !== undefined ? `$${opp.premium.toFixed(2)}` : `~$${opp.premium.toFixed(2)}`}</td>
                  <td className="p-3 font-mono text-green-400 font-bold">${opp.totalPremium.toFixed(0)}</td>
                  <td className="p-3">
                    <span className={`font-bold text-sm ${opp.annualizedReturn>=40?'text-amber-300':opp.annualizedReturn>=30?'text-emerald-300':'text-green-400'}`}>
                      {opp.urgency==='high' && '🔥 '}{opp.annualizedReturn.toFixed(1)}%
                    </span>
                  </td>
                  <td className="p-3">
                    <div className={`font-bold text-sm ${opp.probProfit >= 80 ? 'text-green-400' : opp.probProfit >= 60 ? 'text-yellow-400' : 'text-orange-400'}`}>
                      {opp.probProfit.toFixed(0)}%
                    </div>
                  </td>
                  {schwabConnected && <td className="p-3 text-slate-300 text-xs">{opp.iv}</td>}
                  {schwabConnected && <td className="p-3 text-slate-400 text-xs">{opp.volume !== '--' ? `${opp.volume}/${opp.openInterest}` : '--'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500 mt-2">{schwabConnected ? '* Real-time data from Schwab. Always verify bid/ask before trading.' : '* Estimates only. Connect Schwab for live options chains with real bid/ask spreads.'}</p>
      </div>

      {/* Stock Positions */}
      <div className="max-w-7xl mx-auto mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold">Stock Positions</h2>
          {positions.length > 0 && <button onClick={() => setModal('clearStocks')} className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 rounded-lg text-xs font-medium flex items-center gap-1"><X size={13}/> Clear All</button>}
        </div>
        <div className="bg-slate-900/50 rounded-xl border border-slate-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 border-b border-slate-700">
              <tr>
                <th onClick={() => handleSort('symbol')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Symbol {stockSort.column === 'symbol' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('shares')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Shares {stockSort.column === 'shares' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('lots')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Lots {stockSort.column === 'lots' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('costBasis')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Cost Basis {stockSort.column === 'costBasis' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('currentPrice')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Current Price {stockSort.column === 'currentPrice' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('marketValue')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">Market Value {stockSort.column === 'marketValue' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th onClick={() => handleSort('pnl')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  <div className="flex items-center gap-1">P&L {stockSort.column === 'pnl' && (stockSort.direction === 'asc' ? <ChevronUp size={14}/> : <ChevronDown size={14}/>)}</div>
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr><td colSpan="8" className="text-center p-8 text-slate-400">No positions. Add stocks or import a CSV.</td></tr>
              ) : getSortedPositions().map(pos => {
                if (!pos.symbol || !pos.costBasis) return null;
                const md = marketData[pos.symbol];
                const price = md?.price || pos.costBasis;
                const mv = price * pos.shares;
                const pnl = (price - pos.costBasis) * pos.shares;
                const pnlPct = ((price - pos.costBasis) / pos.costBasis) * 100;
                const lots = Math.floor(pos.shares / 100);
                return (
                  <tr key={pos.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                    <td className="p-3 font-bold text-emerald-400">{pos.symbol}</td>
                    <td className="p-3 font-mono">{pos.shares.toLocaleString()}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${lots>0?'bg-emerald-500/20 text-emerald-300':'bg-slate-700 text-slate-400'}`}>{lots}</span></td>
                    <td className="p-3 font-mono">${pos.costBasis.toFixed(2)}</td>
                    <td className="p-3 font-mono">
                      {md ? (
                        <div>
                          <div>${price.toFixed(2)}</div>
                          <div className={`text-xs ${md.changePercent>=0?'text-green-400':'text-red-400'}`}>{md.changePercent>=0?'+':''}{md.changePercent?.toFixed(2)}%</div>
                          {md.lastUpdated && <div className="text-xs text-slate-600">{new Date(md.lastUpdated).toLocaleTimeString()}</div>}
                        </div>
                      ) : <span className="text-slate-500">--</span>}
                    </td>
                    <td className="p-3 font-mono">${mv.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td className="p-3">
                      <div className={`font-bold text-xs ${pnl>=0?'text-green-400':'text-red-400'}`}>{pnl>=0?'+':''}${pnl.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                      <div className={`text-xs ${pnl>=0?'text-green-400':'text-red-400'}`}>{pnl>=0?'+':''}{pnlPct.toFixed(2)}%</div>
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEditStock(pos)} className="text-blue-400 hover:text-blue-300"><Edit2 size={15}/></button>
                        <button onClick={() => openManualPrice(pos.symbol)} className="text-green-400 hover:text-green-300" title="Set Price">$</button>
                        <button onClick={() => removeStock(pos.id)} className="text-red-400 hover:text-red-300"><X size={15}/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Option Positions */}
      <div className="max-w-7xl mx-auto mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold">Option Positions</h2>
          {optionPositions.length > 0 && <button onClick={() => setModal('clearOptions')} className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 rounded-lg text-xs font-medium flex items-center gap-1"><X size={13}/> Clear All</button>}
        </div>
        <div className="bg-slate-900/50 rounded-xl border border-slate-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 border-b border-slate-700">
              <tr>
                <th className="text-left p-3 text-slate-400 font-medium">Symbol</th>
                <th className="text-left p-3 text-slate-400 font-medium">Type</th>
                <th className="text-left p-3 text-slate-400 font-medium">Position</th>
                <th className="text-left p-3 text-slate-400 font-medium">Strike</th>
                <th className="text-left p-3 text-slate-400 font-medium">Stock Price</th>
                <th className="text-left p-3 text-slate-400 font-medium">Expiration</th>
                <th className="text-left p-3 text-slate-400 font-medium">DTE</th>
                <th className="text-left p-3 text-slate-400 font-medium">Contracts</th>
                <th className="text-left p-3 text-slate-400 font-medium">Entry Premium</th>
                <th className="text-left p-3 text-slate-400 font-medium">Current Premium</th>
                <th className="text-left p-3 text-slate-400 font-medium">Entry Value</th>
                <th className="text-left p-3 text-slate-400 font-medium">Current Value</th>
                <th className="text-left p-3 text-slate-400 font-medium">P&L</th>
                <th className="text-left p-3 text-slate-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {optionPositions.length === 0 ? (
                <tr><td colSpan="14" className="text-center p-8 text-slate-400">No option positions. Click "Add Option" to track your covered calls and long positions.</td></tr>
              ) : optionPositions.map(opt => {
                const dte = Math.ceil((new Date(opt.expiration) - new Date()) / (1000*60*60*24));
                const expiring = dte <= 7 && dte >= 0;
                const expired = dte < 0;
                
                const stockData = marketData[opt.symbol];
                const stockPrice = stockData?.price || 0;
                
                let currentPremium = 0;
                if (stockPrice > 0 && dte > 0) {
                  if (opt.type === 'call') {
                    const calc = calcOptionData(stockPrice, opt.strike, dte);
                    currentPremium = calc.premium;
                  } else {
                    const calc = calcOptionData(opt.strike, stockPrice, dte);
                    currentPremium = calc.premium;
                  }
                } else if (expired) {
                  if (opt.type === 'call') {
                    currentPremium = Math.max(0, stockPrice - opt.strike);
                  } else {
                    currentPremium = Math.max(0, opt.strike - stockPrice);
                  }
                }
                
                const entryValue = opt.premium * opt.quantity * 100;
                const currentValue = currentPremium * opt.quantity * 100;
                
                const pnl = opt.position === 'short' 
                  ? entryValue - currentValue
                  : currentValue - entryValue;
                
                const pnlPercent = opt.position === 'short'
                  ? ((entryValue - currentValue) / entryValue) * 100
                  : ((currentValue - entryValue) / entryValue) * 100;
                
                return (
                  <tr key={opt.id} className={`border-b border-slate-800 hover:bg-slate-800/40 ${expiring?'bg-amber-950/10':expired?'bg-red-950/10':''}`}>
                    <td className="p-3 font-bold text-blue-400">{opt.symbol}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${opt.type==='call'?'bg-green-500/20 text-green-300':'bg-purple-500/20 text-purple-300'}`}>{opt.type.toUpperCase()}</span></td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${opt.position==='short'?'bg-orange-500/20 text-orange-300':'bg-blue-500/20 text-blue-300'}`}>{opt.position==='short'?'SHORT':'LONG'}</span></td>
                    <td className="p-3 font-mono text-emerald-400">${opt.strike.toFixed(2)}</td>
                    <td className="p-3 font-mono">
                      {stockPrice > 0 ? (
                        <div>
                          <div>${stockPrice.toFixed(2)}</div>
                          {stockData?.changePercent !== undefined && (
                            <div className={`text-xs ${stockData.changePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {stockData.changePercent >= 0 ? '+' : ''}{stockData.changePercent.toFixed(2)}%
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className="p-3 text-slate-300">{new Date(opt.expiration).toLocaleDateString()}</td>
                    <td className="p-3"><span className={`text-xs font-semibold ${expired?'text-red-400':expiring?'text-amber-400':'text-slate-400'}`}>{expired?'EXPIRED':dte===0?'Today':`${dte}d`}</span></td>
                    <td className="p-3 font-mono">{opt.quantity}</td>
                    <td className="p-3 font-mono text-slate-300">${opt.premium.toFixed(2)}</td>
                    <td className="p-3 font-mono">
                      {stockPrice > 0 && !expired ? (
                        <div>
                          <div className="text-yellow-300">~${currentPremium.toFixed(2)}</div>
                          <div className="text-xs text-slate-500">est.</div>
                        </div>
                      ) : expired ? (
                        <div className="text-slate-400">${currentPremium.toFixed(2)}</div>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className={`p-3 font-mono font-medium ${opt.position==='short'?'text-green-400':'text-red-400'}`}>
                      {opt.position==='short'?'+':'-'}${entryValue.toFixed(2)}
                    </td>
                    <td className={`p-3 font-mono font-medium ${opt.position==='short'?'text-red-400':'text-green-400'}`}>
                      {stockPrice > 0 ? (
                        <div>
                          <div>{opt.position==='short'?'-':'+'}${currentValue.toFixed(2)}</div>
                          <div className="text-xs text-slate-500">est.</div>
                        </div>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className="p-3">
                      {stockPrice > 0 ? (
                        <div>
                          <div className={`font-bold text-xs ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                          </div>
                          <div className={`text-xs ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pnl >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEditOption(opt)} className="text-blue-400 hover:text-blue-300"><Edit2 size={15}/></button>
                        <button onClick={() => removeOption(opt.id)} className="text-red-400 hover:text-red-300"><X size={15}/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="max-w-7xl mx-auto p-4 bg-slate-900/30 rounded-lg border border-slate-800 text-xs text-slate-500 space-y-1">
        <p><strong className="text-slate-400">Schwab Integration:</strong> Connect your Schwab account to get real-time stock prices and live options chains with actual bid/ask spreads, Greeks, and IV. Without connection, estimates are used.</p>
        <p><strong className="text-slate-400">Breakeven:</strong> Stock price minus premium collected. The "cushion" shows downside protection.</p>
        <p><strong className="text-slate-400">Probability of Profit (PoP):</strong> Probability stock stays above breakeven by expiration.</p>
        <p><strong className="text-slate-400">CSV Format:</strong> Symbol, Shares, CostBasis — e.g. AAPL,200,150.00</p>
      </div>

      {/* Modals */}
      {(modal === 'addStock' || modal === 'editStock') && <StockModal />}
      {(modal === 'addOption' || modal === 'editOption') && <OptionModal />}
      {modal === 'clearStocks' && <ConfirmModal type="stocks" />}
      {modal === 'clearOptions' && <ConfirmModal type="options" />}
      
      {/* Manual Auth Modal */}
      {showManualAuth && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-xl border border-blue-500 p-6 w-full max-w-2xl">
            <h3 className="text-lg font-bold mb-4">Connect to Schwab</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-300 mb-2">Step 1: Click this link to authorize (opens in new tab)</label>
                <a href={schwabStatus} target="_blank" rel="noopener noreferrer" 
                   className="block w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-3 rounded-lg text-center font-medium">
                  Open Schwab Authorization →
                </a>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2">Step 2: After authorizing, Schwab will redirect with a "code" in the URL. Copy the code parameter from the URL.</label>
                <div className="bg-slate-800 p-3 rounded text-xs text-slate-400 font-mono break-all mb-2">
                  Example: https://127.0.0.1<span className="text-amber-400">?code=ABC123...</span>
                </div>
                <div className="text-xs text-amber-400 mt-2">
                  Note: Your browser may show a security warning. Click through it and copy the code from the URL bar.
                </div>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2">Step 3: Paste the code here</label>
                <input 
                  key="auth-code-input"
                  autoFocus
                  type="text"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && authCode.trim() && submitAuthCode()}
                  placeholder="Paste authorization code here"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={submitAuthCode} disabled={!authCode.trim()} 
                        className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-lg font-medium">
                  Connect
                </button>
                <button onClick={() => { setShowManualAuth(false); setAuthCode(''); }} 
                        className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg font-medium">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual Price Modal */}
      {modal === 'manualPrice' && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-xl border border-green-500 p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold mb-4">Set Price for {manualPriceSymbol}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Current Price</label>
                <input 
                  type="number"
                  step="0.01"
                  value={manualPriceValue}
                  onChange={(e) => setManualPriceValue(e.target.value)}
                  placeholder="643.22"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-green-500"
                  autoFocus
                />
              </div>
              <div className="text-xs text-slate-500">
                This will override the web-fetched price. Opportunities will recalculate immediately.
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={saveManualPrice} disabled={!manualPriceValue} 
                      className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 py-2 rounded-lg font-medium">
                Set Price
              </button>
              <button onClick={() => setModal(null)} 
                      className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg font-medium">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PortfolioMonetizer;
