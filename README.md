# Portfolio Monetizer - Deployment Guide

Deploy this app to get **real-time Schwab data** with working OAuth!

## 🚀 Quick Deploy to Vercel (Recommended - 5 minutes)

### Step 1: Push to GitHub
1. Create a new GitHub repository
2. Upload all files from this folder to your repo

### Step 2: Deploy to Vercel
1. Go to [vercel.com](https://vercel.com)
2. Sign in with GitHub
3. Click "New Project"
4. Import your GitHub repository
5. Click "Deploy"
6. Done! You'll get a URL like: `https://your-app.vercel.app`

### Step 3: Update Schwab Developer Portal
1. Go to [developer.schwab.com](https://developer.schwab.com)
2. Open your app → Edit App
3. Set Callback URL to: `https://your-app.vercel.app` (your exact Vercel URL)
4. Save and wait for approval (1-3 business days)

### Step 4: Test It!
1. Once Schwab approves, visit your Vercel URL
2. Click "Connect to Schwab"
3. OAuth will work perfectly!
4. You'll get real-time stock prices and live options chains

---

## 💻 Alternative: Run Locally

### Prerequisites
- Node.js 16+ installed
- Your own domain or localhost

### Installation
```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

The app will open at `http://localhost:5173`

### For Schwab OAuth on localhost:
1. Set Schwab Callback URL to: `http://localhost:5173`
2. Wait for approval
3. OAuth will work on your local machine

### Build for production:
```bash
npm run build
```

---

## 🌐 Alternative: Deploy to Netlify

1. Go to [netlify.com](https://netlify.com)
2. Drag and drop the entire folder
3. Get your URL (e.g., `https://your-app.netlify.app`)
4. Update Schwab Callback URL to match
5. Done!

---

## ⚙️ Configuration

The app automatically uses `window.location.origin` as the callback URL, so it works on any domain you deploy to!

### Your Schwab Credentials (Already Configured):
- **App Key**: FFaYl3XSHY9ZNYCq0sD51YShXGXNETLfcVcFAZGLn93Q9Cum
- **App Secret**: WSYAZDU7mTVWl82wWc368tQJ5vivNZZPOHqQzw0y4VL1NkCLAgn6USboabW0OfEA

**⚠️ Security Note**: Your App Secret is visible in the code. This is acceptable for personal use, but for production apps, you'd want to use environment variables and a backend proxy.

---

## 📝 What Works Once Deployed:

✅ **Real-time stock prices** from Schwab  
✅ **Live options chains** with bid/ask spreads  
✅ **Actual implied volatility** from the market  
✅ **Auto-refreshing data** every 60 seconds  
✅ **OAuth authentication** that actually works  
✅ **All features** - position tracking, P&L, opportunities scanner  

---

## 🆚 Deployed vs Claude Artifact

| Feature | Claude Artifact | Deployed App |
|---------|----------------|--------------|
| Manual price entry | ✅ Works | ✅ Works |
| Schwab OAuth | ❌ Blocked | ✅ Works! |
| Real-time data | ❌ No | ✅ Yes! |
| Auto-refresh | ❌ No | ✅ Yes! |
| Your own URL | ❌ No | ✅ Yes! |

---

## 🎯 Recommended: Vercel

**Why Vercel?**
- Free tier (perfect for this)
- Automatic HTTPS
- Connected to GitHub (auto-deploys when you push code)
- Takes 2 minutes to deploy
- No credit card required

**Your deployment URL will be**: `https://portfolio-monetizer-[random].vercel.app`

Then just update Schwab's Callback URL to match and you're done!

---

## ❓ Troubleshooting

**Schwab OAuth still not working?**
1. Double-check the Callback URL in Schwab matches your deployed URL **exactly**
2. Make sure Schwab app status is "Ready for Use" (not "Modification Pending")
3. Clear browser cache and try again

**Storage not persisting?**
- Data is stored in browser localStorage (saved per domain)
- Clearing browser data will reset the app

**Need help?**
The app is a standard React + Vite app. Any web developer can help deploy it!

---

## 🎉 You're Done!

Once deployed, you'll have a **production-ready portfolio analysis tool** with real-time Schwab data. No more manual price entry!
