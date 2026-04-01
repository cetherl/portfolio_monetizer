/* Portfolio Monetizer v2 - Supabase Integration */
"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TrendingUp, TrendingDown, AlertCircle, DollarSign, Upload, Download, Plus, X, Bell, Target, Calendar, Percent, Edit2, RefreshCw, ChevronDown, ChevronUp, Zap, Check, FileText, LogOut, User } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import type { User as SupabaseUser } from '@supabase/supabase-js';

// Storage adapter - uses localStorage for deployed app
const storage = {
  async get(key: string) {
    try {
      const value = localStorage.getItem(key);
      return value ? { value } : null;
    } catch {
      return null;
    }
  },
  async set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
      return { key, value };
    } catch {
      return null;
    }
  }
};

// ─── Schwab API Configuration ──────────────────────────────────────────────
const SCHWAB_CONFIG = {
  clientId: 'FFaYl3XSHY9ZNYCq0sD51YShXGXNETLfcVcFAZGLn93Q9Cum',
  clientSecret: 'WSYAZDU7mTVWl82wWc368tQJ5vivNZZPOHqQzw0y4VL1NkCLAgn6USboabW0OfEA',
  get redirectUri() { return typeof window !== 'undefined' ? window.location.origin : '' },
  authUrl: 'https://api.schwabapi.com/v1/oauth/authorize',
  tokenUrl: 'https://api.schwabapi.com/v1/oauth/token',
  quotesUrl: 'https://api.schwabapi.com/marketdata/v1/quotes',
  optionsUrl: 'https://api.schwabapi.com/marketdata/v1/chains'
};

// ─── Types ─────────────────────────────────────────────────────────────────
interface Position {
  id: number;
  symbol: string;
  shares: number;
  costBasis: number;
}

interface OptionPosition {
  id: number;
  symbol: string;
  type: 'call' | 'put';
  position: 'short' | 'long';
  strike: number;
  expiration: string;
  quantity: number;
  premium: number;
}

interface MarketDataItem {
  price: number;
  change: number;
  changePercent: number;
  lastUpdated?: string;
  bidSize?: number;
  askSize?: number;
  volume?: number;
}

interface Opportunity {
  id: string;
  symbol: string;
  strategyType: string;
  lots: number;
  currentPrice: number;
  costBasis: number;
  strike: number;
  expiration: string;
  expirationLabel: string;
  dte: number;
  premium: number;
  bid?: number;
  ask?: number;
  totalPremium: number;
  annualizedReturn: number;
  safetyMargin: number;
  delta: number;
  probOTM: number;
  breakeven: number;
  probProfit: number;
  iv: string;
  volume: number | string;
  openInterest: number | string;
  urgency: string;
  note: string;
}

// ─── Black-Scholes (fallback only) ─────────────────────────────────────────
const norm = (x: number) => {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1/(1+p*Math.abs(x)/Math.sqrt(2));
  const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x/2);
  return 0.5*(1+sign*y);
};

const bsCallPrice = (S: number, K: number, T: number, r: number, sigma: number) => {
  if (T <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S/K) + (r + sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return S*norm(d1) - K*Math.exp(-r*T)*norm(d2);
};

const calcOptionData = (stockPrice: number, strike: number, daysToExp: number, ivEstimate = 0.45) => {
  const T = daysToExp / 365;
  const r = 0.05;
  const premium = bsCallPrice(stockPrice, strike, T, r, ivEstimate);
  const d1 = (Math.log(stockPrice/strike) + (r + ivEstimate*ivEstimate/2)*T) / (ivEstimate*Math.sqrt(T));
  const delta = norm(d1);
  const probOTM = 1 - delta;
  return { premium: Math.max(0.01, premium), delta, probOTM };
};

const getExpirations = () => {
  const expirations: { date: string; label: string; dte: number }[] = [];
  const today = new Date();
  for (let monthOffset = 0; monthOffset <= 6; monthOffset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    let fridays = 0;
    while (fridays < 3) {
      if (d.getDay() === 5) fridays++;
      if (fridays < 3) d.setDate(d.getDate() + 1);
    }
    const dte = Math.ceil((d.getTime() - today.getTime()) / (1000*60*60*24));
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

export default function PortfolioMonetizer() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [optionPositions, setOptionPositions] = useState<OptionPosition[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [alerts, setAlerts] = useState<{ id: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [priceLoading, setPriceLoading] = useState(false);
  const [marketData, setMarketData] = useState<Record<string, MarketDataItem>>({});
  const [liveOptionPrices, setLiveOptionPrices] = useState<Record<string, { bid: number; ask: number; mark: number }>>({});
  const [selectedTimeframe, setSelectedTimeframe] = useState('monthly');
  
  // Supabase auth state
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const router = useRouter();
  
  // Schwab OAuth
  const [schwabToken, setSchwabToken] = useState<string | null>(null);
  const [schwabRefreshToken, setSchwabRefreshToken] = useState<string | null>(null);
  const [schwabConnected, setSchwabConnected] = useState(false);
  const [schwabStatus, setSchwabStatus] = useState('');
  
  // Sorting state
  const [stockSort, setStockSort] = useState<{ column: string | null; direction: 'asc' | 'desc' }>({ column: null, direction: 'asc' });
  const [oppSort, setOppSort] = useState<{ column: string; direction: 'asc' | 'desc' }>({ column: 'annualizedReturn', direction: 'desc' });

  // Modal states
  const [modal, setModal] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<number | null>(null);
  const [showManualAuth, setShowManualAuth] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [manualPriceSymbol, setManualPriceSymbol] = useState('');
  const [manualPriceValue, setManualPriceValue] = useState('');
  
  // Dropdown states
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [importDropdownOpen, setImportDropdownOpen] = useState(false);
  const templateDropdownRef = useRef<HTMLDivElement>(null);
  const importDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(event.target as Node)) {
        setTemplateDropdownOpen(false);
      }
      if (importDropdownRef.current && !importDropdownRef.current.contains(event.target as Node)) {
        setImportDropdownOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    } catch {
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
      setSchwabStatus(`Error: ${(error as Error).message}`);
    }
  };

  const submitAuthCode = () => {
    if (authCode.trim()) {
      exchangeCodeForToken(authCode.trim());
      setShowManualAuth(false);
      setAuthCode('');
    }
  };

  const exchangeCodeForToken = async (code: string) => {
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
      setSchwabStatus('Connected to Schwab!');
      
      if (positions.length > 0) fetchPrices();
    } catch(error) {
      console.error('Token exchange error:', error);
      setSchwabStatus(`Connection failed: ${(error as Error).message}`);
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

// ─── Supabase Auth ──────────────────────────────────────────────────────────
  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setAuthLoading(false);
    };
    checkAuth();
    
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    
    return () => subscription.unsubscribe();
  }, [supabase.auth]);
  
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setPositions([]);
    setOptionPositions([]);
    router.push('/auth/login');
  };

  // ─── Storage (Supabase + localStorage fallback) ────────────────────────────
  const loadAll = async () => {
    if (user) {
      // Load from Supabase
      try {
        const { data: stockData } = await supabase
          .from('stock_positions')
          .select('*')
          .eq('user_id', user.id);
        if (stockData && stockData.length > 0) {
          setPositions(stockData.map(p => ({
            id: p.id,
            symbol: p.symbol,
            shares: p.shares,
            costBasis: p.cost_basis
          })));
        }
        
        const { data: optionData } = await supabase
          .from('option_positions')
          .select('*')
          .eq('user_id', user.id);
        if (optionData && optionData.length > 0) {
          setOptionPositions(optionData.map(o => ({
            id: o.id,
            symbol: o.symbol,
            type: o.type,
            position: o.position,
            strike: Number(o.strike),
            expiration: o.expiration,
            quantity: o.contracts,
            premium: Number(o.entry_premium)
          })));
        }
      } catch (err) {
        console.error('Error loading from Supabase:', err);
      }
    } else {
      // Fallback to localStorage
      try {
        const r1 = await storage.get('portfolio-positions');
        if (r1) {
          const valid = JSON.parse(r1.value).filter((p: Position) => p?.symbol && p?.shares && p?.costBasis);
          setPositions(valid);
        }
      } catch {}
      try {
        const r2 = await storage.get('portfolio-option-positions');
        if (r2) setOptionPositions(JSON.parse(r2.value));
      } catch {}
    }
  };
  
  const savePositions = async (list: Position[]) => {
    setPositions(list);
    
    if (user) {
      // Save to Supabase - delete all and re-insert
      try {
        await supabase.from('stock_positions').delete().eq('user_id', user.id);
        if (list.length > 0) {
          await supabase.from('stock_positions').insert(
            list.map(p => ({
              user_id: user.id,
              symbol: p.symbol,
              shares: p.shares,
              cost_basis: p.costBasis
            }))
          );
        }
      } catch (err) {
        console.error('Error saving to Supabase:', err);
      }
    }
    
    // Always save to localStorage as backup
    await storage.set('portfolio-positions', JSON.stringify(list));
  };
  
  const saveOptions = async (list: OptionPosition[]) => {
    setOptionPositions(list);
    
    if (user) {
      // Save to Supabase - delete all and re-insert
      try {
        await supabase.from('option_positions').delete().eq('user_id', user.id);
        if (list.length > 0) {
          await supabase.from('option_positions').insert(
            list.map(o => ({
              user_id: user.id,
              symbol: o.symbol,
              type: o.type,
              position: o.position,
              strike: o.strike,
              expiration: o.expiration,
              contracts: o.quantity,
              entry_premium: o.premium
            }))
          );
        }
      } catch (err) {
        console.error('Error saving options to Supabase:', err);
      }
    }
    
    // Always save to localStorage as backup
    await storage.set('portfolio-option-positions', JSON.stringify(list));
  };
  
  // Migrate localStorage data to Supabase when user logs in
  const migrateLocalDataToSupabase = async () => {
    if (!user) return;
    
    // Check if user already has data in Supabase
    const { data: existingStocks } = await supabase
      .from('stock_positions')
      .select('id')
      .eq('user_id', user.id)
      .limit(1);
    
    if (existingStocks && existingStocks.length > 0) return; // Already has data
    
    // Load from localStorage
    try {
      const r1 = await storage.get('portfolio-positions');
      if (r1) {
        const localPositions = JSON.parse(r1.value).filter((p: Position) => p?.symbol && p?.shares && p?.costBasis);
        if (localPositions.length > 0) {
          await supabase.from('stock_positions').insert(
            localPositions.map((p: Position) => ({
              user_id: user.id,
              symbol: p.symbol,
              shares: p.shares,
              cost_basis: p.costBasis
            }))
          );
        }
      }
      
      const r2 = await storage.get('portfolio-option-positions');
      if (r2) {
        const localOptions = JSON.parse(r2.value);
        if (localOptions.length > 0) {
          await supabase.from('option_positions').insert(
            localOptions.map((o: OptionPosition) => ({
              user_id: user.id,
              symbol: o.symbol,
              type: o.type,
              position: o.position,
              strike: o.strike,
              expiration: o.expiration,
              contracts: o.quantity,
              entry_premium: o.premium
            }))
          );
        }
      }
    } catch (err) {
      console.error('Error migrating data to Supabase:', err);
    }
  };
  
  // Run migration when user logs in
  useEffect(() => {
    if (user) {
      migrateLocalDataToSupabase().then(() => loadAll());
    }
  }, [user]);

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

  // ─── Fetch Live Option Prices for User's Option Positions ─────────────────
  const fetchLiveOptionPrices = async () => {
    if (!schwabToken || optionPositions.length === 0) return;
    
    const newPrices: Record<string, { bid: number; ask: number; mark: number }> = {};
    const symbolsToFetch = [...new Set(optionPositions.map(o => o.symbol))];
    
    for (const symbol of symbolsToFetch) {
      try {
        // Fetch both CALL and PUT chains
        const [callResponse, putResponse] = await Promise.all([
          fetch(`/api/schwab/options?symbol=${encodeURIComponent(symbol)}&contractType=CALL&includeQuotes=true`, {
            headers: { 'Authorization': `Bearer ${schwabToken}`, 'Accept': 'application/json' }
          }),
          fetch(`/api/schwab/options?symbol=${encodeURIComponent(symbol)}&contractType=PUT&includeQuotes=true`, {
            headers: { 'Authorization': `Bearer ${schwabToken}`, 'Accept': 'application/json' }
          })
        ]);
        
        const callData = callResponse.ok ? await callResponse.json() : null;
        const putData = putResponse.ok ? await putResponse.json() : null;
        
        // Find matching contracts for user's option positions
        for (const opt of optionPositions.filter(o => o.symbol === symbol)) {
          const chainData = opt.type === 'call' ? callData : putData;
          const expDateMap = opt.type === 'call' ? chainData?.callExpDateMap : chainData?.putExpDateMap;
          
          if (!expDateMap) continue;
          
          // Find matching expiration
          for (const [expDateStr, strikes] of Object.entries(expDateMap)) {
            const expDate = expDateStr.split(':')[0];
            if (expDate !== opt.expiration) continue;
            
            // Find matching strike - try multiple formats
            const strikeKeys = [
              opt.strike.toFixed(1),
              opt.strike.toString(),
              opt.strike.toFixed(0),
              opt.strike.toFixed(2)
            ];
            let contracts = null;
            for (const key of strikeKeys) {
              if ((strikes as Record<string, unknown[]>)[key]) {
                contracts = (strikes as Record<string, unknown[]>)[key];
                break;
              }
            }
            
            if (contracts && contracts[0]) {
              const contract = contracts[0] as Record<string, unknown>;
              const key = `${opt.symbol}-${opt.type}-${opt.strike}-${opt.expiration}`;
              newPrices[key] = {
                bid: (contract.bid as number) || 0,
                ask: (contract.ask as number) || 0,
                mark: (contract.mark as number) || ((contract.bid as number || 0) + (contract.ask as number || 0)) / 2
              };
            }
          }
        }
      } catch (error) {
        console.error('Error fetching option prices for', symbol, error);
      }
    }
    
    setLiveOptionPrices(newPrices);
  };

  const fetchPricesFromSchwab = async () => {
    const symbols = positions.map(p => p.symbol).join(',');
    try {
      const response = await fetch(`/api/schwab/quotes?symbols=${encodeURIComponent(symbols)}`, {
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
      const newData: Record<string, MarketDataItem> = {};

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
      setSchwabStatus('Prices updated from Schwab');
      
      // Also fetch live option prices for user's option positions
      fetchLiveOptionPrices();
    } catch(error) {
      console.error('Schwab price fetch error:', error);
      setSchwabStatus(`Error: ${(error as Error).message}`);
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
      let priceMap: Record<string, { price: number; change?: number; changePercent?: number }> = {};
      for (const block of (result.content || [])) {
        if (block.type === 'text') {
          try {
            const clean = block.text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            priceMap = JSON.parse(clean);
            break;
          } catch {}
        }
      }
      if (Object.keys(priceMap).length > 0) {
        const newData: Record<string, MarketDataItem> = {};
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
    } catch {
      console.error('Claude price fetch error');
      const cached: Record<string, MarketDataItem> = {};
      for (const pos of positions) {
        try {
          const r = await storage.get(`price-${pos.symbol}`);
          cached[pos.symbol] = r ? JSON.parse(r.value) : { price: pos.costBasis, change: 0, changePercent: 0 };
        } catch { cached[pos.symbol] = { price: pos.costBasis, change: 0, changePercent: 0 }; }
      }
      setMarketData(cached);
    }
  };
  // ─── Fetch Options Chain from Schwab ───────────────────────────────────────
  const fetchOptionsChain = async (symbol: string) => {
    if (!schwabToken) return null;
    
    try {
      const response = await fetch(
        `/api/schwab/options?symbol=${encodeURIComponent(symbol)}&contractType=CALL&includeQuotes=true`,
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
        const data = await response.json();
        return data;
      } catch(error) {
        console.error('Options chain fetch error:', error);
        return null;
      }
    };

  // ─── Opportunity Scanner ───────────────────────────────────────────────────
  const scanOpportunities = useCallback(async () => {
    const opps: Opportunity[] = [];

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
          const dte = Math.ceil((new Date(expDate).getTime() - new Date().getTime()) / (1000*60*60*24));
          
          const targetDTE = selectedTimeframe === 'weekly' ? [5,12] : selectedTimeframe === 'monthly' ? [20,45] : [60,90];
          if (dte < targetDTE[0] || dte > targetDTE[1]) continue;


          
          for (const [strikeStr, contracts] of Object.entries(strikes as Record<string, unknown[]>)) {
            const contract = (contracts as Record<string, unknown>[])[0];
            const K = parseFloat(strikeStr);
            
            if (K <= pos.costBasis) continue;
            if (K <= S * 1.03) continue;

            // Schwab API uses bid, ask, mark directly
            const bid = (contract.bid as number) || 0;
            const ask = (contract.ask as number) || 0;
            const mark = (contract.mark as number) || ((bid + ask) / 2);
            const premium = mark;
            
            if (premium < 0.01) continue;

            const annualizedReturn = (premium / S) * (365 / dte) * 100;
            if (annualizedReturn < 20) continue;

            const totalPremium = premium * lots * 100;
            const breakeven = S - premium;
            
            const T = dte / 365;
            const r = 0.05;
            const sigma = contract.volatility || 0.45;
            const d_breakeven = (Math.log(S / breakeven) + (r - sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
            const probAboveBreakeven = norm(d_breakeven) * 100;

            const delta = contract.delta || 0.3;
            const probOTM = (1 - Math.abs(delta)) * 100;
            const safetyMargin = ((K - S) / S) * 100;

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

    // Limit to max 3 per stock, max 10 total
    const symbolCount: Record<string, number> = {};
    const limited = unique.filter(o => {
      symbolCount[o.symbol] = (symbolCount[o.symbol] || 0) + 1;
      return symbolCount[o.symbol] <= 3;
    }).slice(0, 10);


  
  setOpportunities(limited);
  
  const hotAlerts = unique.filter(o => o.annualizedReturn >= 40).slice(0, 3).map(o => ({
  id: o.id,
      message: `${o.symbol} $${o.strike}C ${o.expirationLabel} - ${o.annualizedReturn.toFixed(1)}% annualized, collect $${o.totalPremium.toFixed(0)} total`
    }));
    setAlerts(hotAlerts);
  }, [positions, marketData, selectedTimeframe, schwabToken]);

  // ─── Stock CRUD ────────────────────────────────────────────────────────────
  const openAddStock = () => { setStockForm({ symbol: '', shares: '', costBasis: '' }); setEditTarget(null); setModal('addStock'); };
  const openEditStock = (pos: Position) => { setStockForm({ symbol: pos.symbol, shares: pos.shares.toString(), costBasis: pos.costBasis.toString() }); setEditTarget(pos.id); setModal('editStock'); };

  const saveStock = () => {
    const { symbol, shares, costBasis } = stockForm;
    if (!symbol || !shares || !costBasis) return;
    const entry = { id: editTarget || Date.now(), symbol: symbol.toUpperCase().trim(), shares: parseInt(shares), costBasis: parseFloat(costBasis) };
    const updated = editTarget ? positions.map(p => p.id === editTarget ? entry : p) : [...positions, entry];
    savePositions(updated);
    setModal(null);
  };

  const openManualPrice = (symbol: string) => {
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

  const removeStock = (id: number) => savePositions(positions.filter(p => p.id !== id));

  // ─── Option CRUD ───────────────────────────────────────────────────────────
  const openAddOption = () => { setOptionForm({ symbol: '', type: 'call', position: 'short', strike: '', expiration: '', quantity: '', premium: '' }); setEditTarget(null); setModal('addOption'); };
  const openEditOption = (opt: OptionPosition) => { setOptionForm({ symbol: opt.symbol, type: opt.type, position: opt.position, strike: opt.strike.toString(), expiration: opt.expiration, quantity: opt.quantity.toString(), premium: opt.premium.toString() }); setEditTarget(opt.id); setModal('editOption'); };

  const saveOption = () => {
    const { symbol, type, position, strike, expiration, quantity, premium } = optionForm;
    if (!symbol || !strike || !expiration || !quantity || !premium) return;
    const entry: OptionPosition = { id: editTarget || Date.now(), symbol: symbol.toUpperCase().trim(), type: type as 'call' | 'put', position: position as 'short' | 'long', strike: parseFloat(strike), expiration, quantity: parseInt(quantity), premium: parseFloat(premium) };
    const updated = editTarget ? optionPositions.map(o => o.id === editTarget ? entry : o) : [...optionPositions, entry];
    saveOptions(updated);
    setModal(null);
  };

  const removeOption = (id: number) => saveOptions(optionPositions.filter(o => o.id !== id));

  // ─── CSV Import for Stocks ────────────────────────────────────────────────
  const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = (ev.target?.result as string).split('\n').filter(l => l.trim());
      const start = lines[0]?.toLowerCase().includes('symbol') ? 1 : 0;
      const imported: Position[] = [];
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

  // ─── CSV Import for Options ─────────────────────────────────������─���────────────
  const importOptionsCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = (ev.target?.result as string).split('\n').filter(l => l.trim());
      const start = lines[0]?.toLowerCase().includes('symbol') ? 1 : 0;
      const imported: OptionPosition[] = [];
      for (let i = start; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        const [symbol, type, position, strike, expiration, quantity, premium] = parts;
        const pStrike = parseFloat((strike || '').replace(/[^\d.]/g, ''));
        const pQuantity = parseInt((quantity || '').replace(/[^\d]/g, ''));
        const pPremium = parseFloat((premium || '').replace(/[^\d.]/g, ''));
        if (symbol && !isNaN(pStrike) && !isNaN(pQuantity) && !isNaN(pPremium) && pQuantity > 0 && pStrike > 0) {
          imported.push({
            id: Date.now() + i,
            symbol: symbol.toUpperCase().replace(/[^A-Z]/g, ''),
            type: (type || 'call').toLowerCase() === 'put' ? 'put' : 'call',
            position: (position || 'short').toLowerCase() === 'long' ? 'long' : 'short',
            strike: pStrike,
            expiration: expiration || new Date().toISOString().split('T')[0],
            quantity: pQuantity,
            premium: pPremium
          });
        }
      }
      if (imported.length > 0) saveOptions([...optionPositions, ...imported]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ─── Export Stocks to CSV ────────────────────��─────────────────────────────
  const exportStocks = () => {
    if (positions.length === 0) return;
    
    const headers = ['Symbol', 'Shares', 'CostBasis', 'CurrentPrice', 'MarketValue', 'PnL', 'PnLPercent'];
    const rows = positions.map(pos => {
      const price = marketData[pos.symbol]?.price || pos.costBasis;
      const marketValue = price * pos.shares;
      const pnl = (price - pos.costBasis) * pos.shares;
      const pnlPercent = ((price - pos.costBasis) / pos.costBasis * 100).toFixed(2);
      return [pos.symbol, pos.shares, pos.costBasis.toFixed(2), price.toFixed(2), marketValue.toFixed(2), pnl.toFixed(2), pnlPercent].join(',');
    });
    
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = `stocks-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a); 
    URL.revokeObjectURL(url);
  };

  // ─── Export Options to CSV ─────────────────────────────────────────────────
  const exportOptions = () => {
    if (optionPositions.length === 0) return;
    
    const headers = ['Symbol', 'Type', 'Position', 'Strike', 'Expiration', 'Quantity', 'Premium'];
    const rows = optionPositions.map(opt => {
      return [opt.symbol, opt.type, opt.position, opt.strike.toFixed(2), opt.expiration, opt.quantity, opt.premium.toFixed(2)].join(',');
    });
    
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = `options-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a); 
    URL.revokeObjectURL(url);
  };

  // ─── Download Templates ────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const csv = "Symbol,Shares,CostBasis\nAAPL,200,150.00\nMSFT,300,380.50\nTSLA,100,245.75";
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'portfolio-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const downloadOptionsTemplate = () => {
    const csv = "Symbol,Type,Position,Strike,Expiration,Quantity,Premium\nAAPL,call,short,155.00,2024-04-19,2,3.50\nMSFT,put,long,400.00,2024-05-17,1,8.25";
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'options-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  // ─── Sorting ───────────────────────────────────────────────────────────────
  const handleSort = (column: string) => {
    setStockSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getSortedPositions = () => {
    if (!stockSort.column) return positions;
    
    const sorted = [...positions].sort((a, b) => {
      let aVal: string | number, bVal: string | number;
      
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
        return stockSort.direction === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      }
      
      return stockSort.direction === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    
    return sorted;
  };

  const handleOppSort = (column: string) => {
    setOppSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getSortedOpportunities = () => {
    if (!oppSort.column) return opportunities;
    return [...opportunities].sort((a, b) => {
      let aVal: string | number, bVal: string | number;
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
      if (typeof aVal === 'string') return oppSort.direction === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      return oppSort.direction === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  };

  // ─── Totals ────────────────────────────────────────────────────────────────
  const totalValue = positions.reduce((s, p) => s + (marketData[p.symbol]?.price || p.costBasis) * p.shares, 0);
  const totalPnL = positions.reduce((s, p) => s + ((marketData[p.symbol]?.price || p.costBasis) - p.costBasis) * p.shares, 0);

  // ─── Shared styles ─────────────────────────────────────────────────────────
  const inp = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500";
  const lbl = "block text-xs text-slate-400 mb-1";

  // ─── Modals ─────────────────────────────────────────────────────────────────


  const ConfirmModal = ({ type }: { type: string }) => (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl p-6 w-full max-w-sm border border-slate-700">
        <h2 className="text-xl font-bold mb-2">Confirm Delete</h2>
        <p className="text-slate-400 mb-4">Delete all {type === 'stocks' ? 'stock' : 'option'} positions? This cannot be undone.</p>
        <div className="flex gap-3">
          <button onClick={() => { type === 'stocks' ? (savePositions([]), setMarketData({}), setOpportunities([])) : saveOptions([]); setModal(null); }} className="flex-1 bg-red-600 hover:bg-red-500 py-2 rounded-lg text-sm font-medium">Yes, Delete All</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium">Cancel</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <DollarSign className="w-8 h-8 text-emerald-400" />
          <h1 className="text-2xl font-bold">Portfolio Monetizer</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {schwabConnected ? (
            <button onClick={disconnectSchwab} className="px-3 py-1.5 bg-green-600/20 text-green-400 border border-green-600/50 rounded-lg text-xs font-medium flex items-center gap-1">
              <Check className="w-3 h-3" /> Schwab Connected
            </button>
          ) : (
            <button onClick={connectSchwab} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-medium flex items-center gap-1">
              <Zap className="w-3 h-3" /> Connect Schwab
            </button>
          )}
          
          {/* Template Dropdown */}
          <div className="relative" ref={templateDropdownRef}>
            <button 
              onClick={() => { setTemplateDropdownOpen(!templateDropdownOpen); setImportDropdownOpen(false); }}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-medium flex items-center gap-1"
            >
              <FileText className="w-3 h-3" /> Templates <ChevronDown className={`w-3 h-3 transition-transform ${templateDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {templateDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50 min-w-[140px]">
                <button 
                  onClick={() => { downloadTemplate(); setTemplateDropdownOpen(false); }} 
                  className="w-full px-3 py-2 text-left text-xs hover:bg-slate-700 rounded-t-lg"
                >
                  Stock Template
                </button>
                <button 
                  onClick={() => { downloadOptionsTemplate(); setTemplateDropdownOpen(false); }} 
                  className="w-full px-3 py-2 text-left text-xs hover:bg-slate-700 rounded-b-lg"
                >
                  Options Template
                </button>
              </div>
            )}
          </div>
          
          {/* Import Dropdown */}
          <div className="relative" ref={importDropdownRef}>
            <button 
              onClick={() => { setImportDropdownOpen(!importDropdownOpen); setTemplateDropdownOpen(false); }}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-medium flex items-center gap-1"
            >
              <Upload className="w-3 h-3" /> Import <ChevronDown className={`w-3 h-3 transition-transform ${importDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {importDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50 min-w-[140px]">
                <label className="block w-full px-3 py-2 text-left text-xs hover:bg-slate-700 cursor-pointer rounded-t-lg">
                  Import Stocks
                  <input type="file" accept=".csv" onChange={(e) => { importCSV(e); setImportDropdownOpen(false); }} className="hidden" />
                </label>
                <label className="block w-full px-3 py-2 text-left text-xs hover:bg-slate-700 cursor-pointer rounded-b-lg">
                  Import Options
                  <input type="file" accept=".csv" onChange={(e) => { importOptionsCSV(e); setImportDropdownOpen(false); }} className="hidden" />
                </label>
              </div>
            )}
          </div>
          
          <button onClick={openAddStock} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium flex items-center gap-1">
            <Plus className="w-3 h-3" /> Stock
          </button>
          <button onClick={openAddOption} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-xs font-medium flex items-center gap-1">
            <Plus className="w-3 h-3" /> Option
          </button>
          <button onClick={fetchPrices} disabled={priceLoading} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${priceLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          
          {/* User Account Menu */}
          {user ? (
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium flex items-center gap-1"
              >
                <User className="w-3 h-3" />
                <span className="hidden sm:inline">{user.email?.split('@')[0]}</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {userMenuOpen && (
                <div className="absolute top-full right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50 min-w-[160px]">
                  <div className="px-3 py-2 text-xs text-slate-400 border-b border-slate-700">
                    {user.email}
                  </div>
                  <div className="px-3 py-2 text-xs text-emerald-400 border-b border-slate-700">
                    Data synced across devices
                  </div>
                  <button
                    onClick={() => { handleSignOut(); setUserMenuOpen(false); }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-slate-700 rounded-b-lg flex items-center gap-2 text-red-400"
                  >
                    <LogOut className="w-3 h-3" /> Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => router.push('/auth/login')}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium flex items-center gap-1"
            >
              <User className="w-3 h-3" /> Sign In
            </button>
          )}
        </div>
      </div>
      <p className="text-sm text-slate-400 mb-6">
        Maximize premium - Protect shares
        {schwabStatus ? <span> - {schwabStatus}</span> : null}
      </p>
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
          <div className="text-sm text-slate-400 mb-1">Portfolio Value</div>
          <div className="text-2xl font-bold">${totalValue.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>
        <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
          <div className="text-sm text-slate-400 mb-1 flex items-center gap-1">{totalPnL >= 0 ? <TrendingUp className="w-4 h-4 text-green-400"/> : <TrendingDown className="w-4 h-4 text-red-400"/>} Unrealized P&L</div>
          <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
          </div>
        </div>
        <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
          <div className="text-sm text-slate-400 mb-1">Opportunities</div>
          <div className="text-2xl font-bold">{opportunities.length}</div>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="bg-amber-900/30 border border-amber-600/50 rounded-xl p-4 mb-6">
          <div className="font-semibold mb-2 flex items-center gap-2"><Bell className="w-4 h-4"/> Hot Opportunities</div>
          {alerts.map((a, i) => <div key={i} className="text-sm text-amber-200">{a.message}</div>)}
        </div>
      )}

      {/* Timeframe Selector */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {(['weekly','monthly','quarterly'] as const).map(tf => (
          <button key={tf} onClick={() => setSelectedTimeframe(tf)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1 ${selectedTimeframe===tf ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'}`}>
            <Calendar className="w-3 h-3"/> {tf.charAt(0).toUpperCase()+tf.slice(1)}
          </button>
        ))}
        <span className="text-xs text-slate-500 ml-auto">
          {schwabConnected ? 'Using live Schwab data' : 'Using estimates - connect Schwab for real data'}
        </span>
      </div>

      {/* Opportunities Table */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-6">
        <h2 className="text-lg font-semibold p-4 border-b border-slate-800">Premium Opportunities (20% Annualized or higher)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/50">
                <th className="text-left p-3 text-slate-400 font-medium">Strategy</th>
                <th onClick={() => handleOppSort('symbol')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Symbol {oppSort.column === 'symbol' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Recommendation</th>
                <th onClick={() => handleOppSort('currentPrice')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Stock {oppSort.column === 'currentPrice' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('strike')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Strike {oppSort.column === 'strike' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('breakeven')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Breakeven {oppSort.column === 'breakeven' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Exp</th>
                <th onClick={() => handleOppSort('dte')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  DTE {oppSort.column === 'dte' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('premium')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Premium {oppSort.column === 'premium' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('totalPremium')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Total $ {oppSort.column === 'totalPremium' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('annualizedReturn')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Ann % {oppSort.column === 'annualizedReturn' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleOppSort('probProfit')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  PoP {oppSort.column === 'probProfit' && (oppSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                {schwabConnected && <th className="text-left p-3 text-slate-400 font-medium">IV</th>}
                {schwabConnected && <th className="text-left p-3 text-slate-400 font-medium">Vol/OI</th>}
              </tr>
            </thead>
            <tbody>
              {opportunities.length === 0 ? (
                <tr><td colSpan={schwabConnected ? 14 : 12} className="p-8 text-center text-slate-500">{loading || priceLoading ? 'Loading...' : positions.length === 0 ? 'Add positions' : 'No opportunities at 20% or higher'}</td></tr>
              ) : getSortedOpportunities().map(opp => (
                <tr key={opp.id} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="p-3"><span className="px-2 py-1 bg-blue-600/20 text-blue-300 rounded text-xs">{opp.strategyType}</span></td>
                  <td className="p-3 font-medium">{opp.symbol}</td>
                  <td className="p-3 text-xs text-slate-400 max-w-[200px] truncate">{opp.note}</td>
                  <td className="p-3">${opp.currentPrice.toFixed(2)}</td>
                  <td className="p-3">${opp.strike}</td>
                  <td className="p-3">
                    <div>${opp.breakeven.toFixed(2)}</div>
                    <div className="text-xs text-slate-500">{((opp.currentPrice - opp.breakeven) / opp.currentPrice * 100).toFixed(1)}%</div>
                  </td>
                  <td className="p-3 text-xs">{opp.expirationLabel}</td>
                  <td className="p-3">{opp.dte}d</td>
                  <td className="p-3">{opp.bid !== undefined ? `$${opp.premium.toFixed(2)}` : `~$${opp.premium.toFixed(2)}`}</td>
                  <td className="p-3 font-medium">${opp.totalPremium.toFixed(0)}</td>
                  <td className="p-3">
                    <span className={`font-bold ${opp.annualizedReturn>=40?'text-amber-300':opp.annualizedReturn>=30?'text-emerald-300':'text-green-400'}`}>
                      {opp.urgency==='high' && 'HOT '}{opp.annualizedReturn.toFixed(1)}%
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`${opp.probProfit >= 80 ? 'text-green-400' : opp.probProfit >= 60 ? 'text-yellow-400' : 'text-orange-400'}`}>
                      {opp.probProfit.toFixed(0)}%
                    </span>
                  </td>
                  {schwabConnected && <td className="p-3 text-xs">{opp.iv}</td>}
                  {schwabConnected && <td className="p-3 text-xs">{opp.volume !== '--' ? `${opp.volume}/${opp.openInterest}` : '--'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-3 text-xs text-slate-500 border-t border-slate-800">
          {schwabConnected ? '* Real-time data from Schwab. Always verify bid/ask before trading.' : '* Estimates only. Connect Schwab for live options chains with real bid/ask spreads.'}
        </div>
      </div>

      {/* Stock Positions */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-6">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold">Stock Positions</h2>
          <div className="flex gap-2">
            <button 
              onClick={exportStocks} 
              disabled={positions.length === 0}
              className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600/80"
            >
              <Download className="w-3 h-3" /> Export
            </button>
            <button 
              onClick={() => setModal('clearStocks')} 
              disabled={positions.length === 0}
              className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600/80"
            >
              <X className="w-3 h-3" /> Clear All
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/50">
                <th onClick={() => handleSort('symbol')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Symbol {stockSort.column === 'symbol' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('shares')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Shares {stockSort.column === 'shares' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('lots')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Lots {stockSort.column === 'lots' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('costBasis')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Cost Basis {stockSort.column === 'costBasis' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('currentPrice')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Current Price {stockSort.column === 'currentPrice' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('marketValue')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  Market Value {stockSort.column === 'marketValue' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th onClick={() => handleSort('pnl')} className="text-left p-3 text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                  P&L {stockSort.column === 'pnl' && (stockSort.direction === 'asc' ? <ChevronUp className="inline w-3 h-3"/> : <ChevronDown className="inline w-3 h-3"/>)}
                </th>
                <th className="text-left p-3 text-slate-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">No positions. Add stocks or import a CSV.</td></tr>
              ) : getSortedPositions().map(pos => {
                if (!pos.symbol || !pos.costBasis) return null;
                const md = marketData[pos.symbol];
                const price = md?.price || pos.costBasis;
                const mv = price * pos.shares;
                const pnl = (price - pos.costBasis) * pos.shares;
                const pnlPct = ((price - pos.costBasis) / pos.costBasis) * 100;
                const lots = Math.floor(pos.shares / 100);
                return (
                  <tr key={pos.id} className="border-t border-slate-800 hover:bg-slate-800/50">
                    <td className="p-3 font-medium">{pos.symbol}</td>
                    <td className="p-3">{pos.shares.toLocaleString()}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${lots>0?'bg-emerald-500/20 text-emerald-300':'bg-slate-700 text-slate-400'}`}>{lots}</span></td>
                    <td className="p-3">${pos.costBasis.toFixed(2)}</td>
                    <td className="p-3">
                      {md ? (
                        <div>
                          <div>${price.toFixed(2)}</div>
                          <div className={`text-xs ${md.changePercent>=0?'text-green-400':'text-red-400'}`}>{md.changePercent>=0?'+':''}{md.changePercent?.toFixed(2)}%</div>
                          {md.lastUpdated && <div className="text-xs text-slate-500">{new Date(md.lastUpdated).toLocaleTimeString()}</div>}
                        </div>
                      ) : <span className="text-slate-500">--</span>}
                    </td>
                    <td className="p-3">${mv.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td className="p-3">
                      <div className={`${pnl>=0?'text-green-400':'text-red-400'}`}>{pnl>=0?'+':''}${pnl.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                      <div className={`text-xs ${pnl>=0?'text-green-400':'text-red-400'}`}>{pnl>=0?'+':''}{pnlPct.toFixed(2)}%</div>
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEditStock(pos)} className="text-blue-400 hover:text-blue-300"><Edit2 className="w-4 h-4"/></button>
                        <button onClick={() => openManualPrice(pos.symbol)} className="text-green-400 hover:text-green-300" title="Set Price"><DollarSign className="w-4 h-4"/></button>
                        <button onClick={() => removeStock(pos.id)} className="text-red-400 hover:text-red-300"><X className="w-4 h-4"/></button>
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
      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-6">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold">Option Positions</h2>
          <div className="flex gap-2">
            <button 
              onClick={exportOptions} 
              disabled={optionPositions.length === 0}
              className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600/80"
            >
              <Download className="w-3 h-3" /> Export
            </button>
            <button 
              onClick={() => setModal('clearOptions')} 
              disabled={optionPositions.length === 0}
              className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600/80"
            >
              <X className="w-3 h-3" /> Clear All
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/50">
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
                <tr><td colSpan={14} className="p-8 text-center text-slate-500">No option positions. Click &quot;Add Option&quot; to track your covered calls and long positions.</td></tr>
              ) : optionPositions.map(opt => {
                const dte = Math.ceil((new Date(opt.expiration).getTime() - new Date().getTime()) / (1000*60*60*24));
                const expiring = dte <= 7 && dte >= 0;
                const expired = dte < 0;
                
                const stockData = marketData[opt.symbol];
                const stockPrice = stockData?.price || 0;
                
// Check for live Schwab price first
  const optionKey = `${opt.symbol}-${opt.type}-${opt.strike}-${opt.expiration}`;
  const livePrice = liveOptionPrices[optionKey];
  
  let currentPremium = 0;
  let usingLivePrice = false;
  
  if (livePrice && livePrice.mark > 0) {
    // Use live Schwab price
    currentPremium = livePrice.mark;
    usingLivePrice = true;
  } else if (stockPrice > 0 && dte > 0) {
    // Fallback to Black-Scholes estimate
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
                  <tr key={opt.id} className="border-t border-slate-800 hover:bg-slate-800/50">
                    <td className="p-3 font-medium">{opt.symbol}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${opt.type==='call'?'bg-blue-500/20 text-blue-300':'bg-purple-500/20 text-purple-300'}`}>{opt.type.toUpperCase()}</span></td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${opt.position==='short'?'bg-orange-500/20 text-orange-300':'bg-green-500/20 text-green-300'}`}>{opt.position==='short'?'SHORT':'LONG'}</span></td>
                    <td className="p-3">${opt.strike.toFixed(2)}</td>
                    <td className="p-3">
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
                    <td className={`p-3 ${expiring ? 'text-amber-400' : expired ? 'text-red-400' : ''}`}>{new Date(opt.expiration).toLocaleDateString()}</td>
                    <td className={`p-3 ${expiring ? 'text-amber-400' : expired ? 'text-red-400' : ''}`}>{expired?'EXPIRED':dte===0?'Today':`${dte}d`}</td>
                    <td className="p-3">{opt.quantity}</td>
                    <td className="p-3">${opt.premium.toFixed(2)}</td>
                    <td className="p-3">
                      {stockPrice > 0 && !expired ? (
                        <div>
                          <span>~${currentPremium.toFixed(2)}</span>
                          <span className="text-xs text-slate-500 ml-1">est.</span>
                        </div>
                      ) : expired ? (
                        <span>${currentPremium.toFixed(2)}</span>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={opt.position==='short'?'text-green-400':'text-red-400'}>
                        {opt.position==='short'?'+':'-'}${entryValue.toFixed(2)}
                      </span>
                    </td>
                    <td className="p-3">
                      {stockPrice > 0 ? (
                        <div>
                          <span className={opt.position==='short'?'text-red-400':'text-green-400'}>{opt.position==='short'?'-':'+'}${currentValue.toFixed(2)}</span>
                          <span className="text-xs text-slate-500 ml-1">est.</span>
                        </div>
                      ) : (
                        <span className="text-slate-500">--</span>
                      )}
                    </td>
                    <td className="p-3">
                      {stockPrice > 0 ? (
                        <div>
                          <div className={`${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
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
                        <button onClick={() => openEditOption(opt)} className="text-blue-400 hover:text-blue-300"><Edit2 className="w-4 h-4"/></button>
                        <button onClick={() => removeOption(opt.id)} className="text-red-400 hover:text-red-300"><X className="w-4 h-4"/></button>
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
      <div className="text-xs text-slate-500 space-y-1 mb-6">
        <p><strong>Schwab Integration:</strong> Connect your Schwab account to get real-time stock prices and live options chains with actual bid/ask spreads, Greeks, and IV. Without connection, estimates are used.</p>
        <p><strong>Breakeven:</strong> Stock price minus premium collected. The &quot;cushion&quot; shows downside protection.</p>
        <p><strong>Probability of Profit (PoP):</strong> Probability stock stays above breakeven by expiration.</p>
        <p><strong>CSV Format:</strong> Symbol, Shares, CostBasis - e.g. AAPL,200,150.00</p>
      </div>

  {/* Stock Modal */}
  {(modal === 'addStock' || modal === 'editStock') && (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setModal(null)}>
      <div className="bg-slate-900 rounded-xl p-6 w-full max-w-md border border-slate-700" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">{editTarget ? 'Edit' : 'Add'} Stock Position</h2>
        <div className="space-y-4">
          <div>
            <label className={lbl}>Symbol</label>
            <input className={inp} value={stockForm.symbol} onChange={e => {
              const newValue = e.target.value.toUpperCase();
              setStockForm(prev => ({...prev, symbol: newValue}));
            }} placeholder="AAPL" onKeyDown={e => e.key === 'Enter' && saveStock()} />
          </div>
          <div>
            <label className={lbl}>Shares</label>
            <input className={inp} type="number" value={stockForm.shares} onChange={e => {
              setStockForm(prev => ({...prev, shares: e.target.value}));
            }} placeholder="200" onKeyDown={e => e.key === 'Enter' && saveStock()} />
          </div>
          <div>
            <label className={lbl}>Cost Basis (per share)</label>
            <input className={inp} type="number" step="0.01" value={stockForm.costBasis} onChange={e => {
              setStockForm(prev => ({...prev, costBasis: e.target.value}));
            }} placeholder="150.00" onKeyDown={e => e.key === 'Enter' && saveStock()} />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={saveStock} className="flex-1 bg-emerald-600 hover:bg-emerald-500 py-2 rounded-lg text-sm font-medium transition-colors">Save</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  )}
  
  {/* Option Modal */}
  {(modal === 'addOption' || modal === 'editOption') && (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setModal(null)}>
      <div className="bg-slate-900 rounded-xl p-6 w-full max-w-md border border-slate-700" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">{editTarget ? 'Edit' : 'Add'} Option Position</h2>
        <div className="space-y-4">
          <div>
            <label className={lbl}>Symbol</label>
            <input className={inp} value={optionForm.symbol} onChange={e => {
              const newValue = e.target.value.toUpperCase();
              setOptionForm(prev => ({...prev, symbol: newValue}));
            }} placeholder="AAPL" onKeyDown={e => e.key === 'Enter' && saveOption()} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Type</label>
              <select className={inp} value={optionForm.type} onChange={e => setOptionForm(prev => ({...prev, type: e.target.value}))}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Position</label>
              <select className={inp} value={optionForm.position} onChange={e => setOptionForm(prev => ({...prev, position: e.target.value}))}>
                <option value="short">Short (Sold)</option>
                <option value="long">Long (Bought)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Strike</label>
              <input className={inp} type="number" step="0.01" value={optionForm.strike} onChange={e => setOptionForm(prev => ({...prev, strike: e.target.value}))} placeholder="155.00" onKeyDown={e => e.key === 'Enter' && saveOption()} />
            </div>
            <div>
              <label className={lbl}>Qty (contracts)</label>
              <input className={inp} type="number" value={optionForm.quantity} onChange={e => setOptionForm(prev => ({...prev, quantity: e.target.value}))} placeholder="2" onKeyDown={e => e.key === 'Enter' && saveOption()} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Expiration</label>
              <input className={inp} type="date" value={optionForm.expiration} onChange={e => setOptionForm(prev => ({...prev, expiration: e.target.value}))} />
            </div>
            <div>
              <label className={lbl}>Premium / share</label>
              <input className={inp} type="number" step="0.01" value={optionForm.premium} onChange={e => setOptionForm(prev => ({...prev, premium: e.target.value}))} placeholder="2.50" onKeyDown={e => e.key === 'Enter' && saveOption()} />
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={saveOption} className="flex-1 bg-emerald-600 hover:bg-emerald-500 py-2 rounded-lg text-sm font-medium transition-colors">Save</button>
          <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-sm font-medium transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  )}
      {modal === 'clearStocks' && <ConfirmModal type="stocks" />}
      {modal === 'clearOptions' && <ConfirmModal type="options" />}
      
      {/* Manual Auth Modal */}
      {showManualAuth && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-xl p-6 w-full max-w-lg border border-slate-700">
            <h2 className="text-xl font-bold mb-4">Connect to Schwab</h2>
            
            <div className="space-y-4">
              <div className="bg-slate-800 rounded-lg p-4">
                <p className="text-sm text-slate-300 mb-2"><strong>Step 1:</strong> Click this link to authorize (opens in new tab)</p>
                <a href={schwabStatus} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm break-all">
                  Open Schwab Authorization
                </a>
              </div>
              
              <div className="bg-slate-800 rounded-lg p-4">
                <p className="text-sm text-slate-300 mb-2"><strong>Step 2:</strong> After authorizing, Schwab will redirect with a &quot;code&quot; in the URL. Copy the code parameter from the URL.</p>
                <p className="text-xs text-slate-500">Example: https://127.0.0.1?code=ABC123...</p>
              </div>
              
              <div className="bg-amber-900/30 border border-amber-600/30 rounded-lg p-3">
                <p className="text-xs text-amber-200">Note: Your browser may show a security warning. Click through it and copy the code from the URL bar.</p>
              </div>
              
              <div>
                <label className="block text-sm text-slate-300 mb-2"><strong>Step 3:</strong> Paste the code here</label>
                <input
                  type="text"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && authCode.trim() && submitAuthCode()}
                  placeholder="Paste authorization code here"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono text-sm"
                />
              </div>
            </div>
            
            <div className="flex gap-3 mt-6">
              <button onClick={submitAuthCode} disabled={!authCode.trim()} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-lg font-medium">
                Connect
              </button>
              <button onClick={() => { setShowManualAuth(false); setAuthCode(''); }} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg font-medium">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Price Modal */}
      {modal === 'manualPrice' && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-xl p-6 w-full max-w-sm border border-slate-700">
            <h2 className="text-xl font-bold mb-4">Set Price for {manualPriceSymbol}</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-300 mb-2">Current Price</label>
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
              
              <p className="text-xs text-slate-500">
                This will override the web-fetched price. Opportunities will recalculate immediately.
              </p>
            </div>
            
            <div className="flex gap-3 mt-6">
              <button onClick={saveManualPrice} className="flex-1 bg-green-600 hover:bg-green-500 py-2 rounded-lg font-medium">
                Set Price
              </button>
              <button onClick={() => setModal(null)} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg font-medium">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
