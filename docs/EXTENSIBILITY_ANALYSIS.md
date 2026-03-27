# AirportMVP Codebase Analysis & Extensibility Guide

> **Generated:** December 2024
> **Purpose:** Comprehensive analysis for extending the codebase with new features

---

## Table of Contents

1. [Basic Structure](#1-basic-structure)
2. [Current Features](#2-current-features)
3. [Hosting & Deployment](#3-hosting--deployment)
4. [Styling](#4-styling)
5. [Extensibility Assessment](#5-extensibility-assessment)
6. [Recommendations](#6-recommendations)
7. [Implementation Guide](#7-implementation-guide)

---

## 1. Basic Structure

### Technology Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Vanilla HTML/CSS/JavaScript (ES6 modules) |
| **Backend** | Node.js + Express.js |
| **Database** | Supabase (PostgreSQL) |
| **Payments** | Stripe |
| **Notifications** | Twilio (SMS/WhatsApp) |
| **Hosting** | Netlify (frontend) + Railway (API) |

**Important:** This is NOT a React, Next.js, or Vue app. It's a traditional single-page application (SPA) built with plain HTML/CSS/JS and libraries loaded via CDN.

### Folder Structure

```
AirportMVP/
│
├── indexMVP.html              # Main SPA entry point (2,671 lines)
├── admin.html                 # Admin dashboard (1,714 lines)
├── offline.html               # PWA offline fallback
├── package.json               # Project dependencies
├── netlify.toml               # Deployment configuration
├── manifest.json              # PWA manifest
│
├── css/                       # Stylesheets
│   ├── style.css              # Main styles (43KB, CSS variables)
│   ├── booking-confirmation.css
│   └── maps-autocomplete.css
│
├── js/                        # Frontend JavaScript modules
│   ├── passenger-modal.js     # Passenger info collection
│   ├── payment-modal.js       # Payment form handling
│   ├── pickup-note-modal.js   # Special instructions
│   ├── promotion-modal.js     # Promo code handling
│   └── stripe-payment.js      # Stripe integration
│
├── backend/
│   ├── api-proxy/             # Express server (Railway-hosted)
│   │   ├── server.js          # Google Maps proxy (17KB)
│   │   └── package.json
│   └── functions/             # Netlify serverless functions
│       ├── calculate-price.js
│       ├── create-booking.js
│       ├── create-checkout-session.js
│       ├── create-payment-intent.js
│       ├── create-payment.js
│       └── stripe-config.js
│
├── database/
│   ├── linkmia-schema.sql     # PostgreSQL schema
│   └── SETUP.md               # Database setup guide
│
├── images/                    # Vehicle and UI images
│   ├── luxury-sedan.jpg
│   ├── premium-suv-escalade.jpg
│   └── vip-sprinter.jpg
│
├── docs/                      # Documentation
│   ├── CODEBASE_ANALYSIS.md
│   ├── PRICING_STRUCTURE.md
│   └── ...
│
├── dev/                       # Development files
│   ├── admin/
│   ├── templates/
│   └── archive/
│
└── Root JavaScript modules
    ├── supabase.js            # Supabase client & auth
    ├── api-config.js          # API endpoints config
    ├── autocomplete.js        # Address autocomplete
    ├── pricing.js             # Pricing logic
    ├── service-worker.js      # PWA service worker
    ├── error-handler.js       # Error management
    ├── debug.js               # Debugging utilities
    └── datetime-utils.js      # Date/time helpers
```

### Package Manager

**npm** is used for dependency management.

### Main Dependencies

```json
{
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "helmet": "^7.0.0",
  "express-rate-limit": "^6.10.0",
  "dotenv": "^16.3.1",
  "axios": "^1.5.0",
  "morgan": "^1.10.0",
  "stripe": "^18.4.0",
  "twilio": "^5.8.0"
}
```

### Dev Dependencies

```json
{
  "nodemon": "^3.0.1",
  "jest": "^29.6.4",
  "supertest": "^6.3.3"
}
```

---

## 2. Current Features

### User Authentication

**Status:** Configured via Supabase Auth

**Location:** `supabase.js`

**Available Methods:**
- `auth.getUser()` - Get current authenticated user
- `auth.getSession()` - Get current session
- `auth.signOut()` - Sign out user
- `auth.onAuthStateChange()` - Listen to auth state changes

**Documentation:** `AUTH_IMPLEMENTATION_GUIDE.md`

### Database

**Status:** Connected via Supabase (PostgreSQL)

**Schema Location:** `database/linkmia-schema.sql`

**Main Tables:**

| Table | Purpose |
|-------|---------|
| `customers` | User accounts with ride history |
| `drivers` | Driver profiles and vehicle info |
| `hosts` | B2B referral partners |
| `bookings` | Trip reservations |
| `trips` | Trip records with pricing |
| `flights` | Flight info for passengers |
| `payments` | Payment records |

**Client Configuration:**
```javascript
// supabase.js
const config = {
    url: 'https://hncpybxwblpkyxvskoxd.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
};
```

### API Integrations

| Service | Purpose | Location |
|---------|---------|----------|
| **Google Maps** | Address autocomplete, directions | `backend/api-proxy/server.js` |
| **Stripe** | Card payments, Apple Pay, Google Pay | `backend/functions/`, `js/stripe-payment.js` |
| **Twilio** | SMS and WhatsApp notifications | `backend/functions/create-booking.js` |
| **SendGrid** | Email notifications | Backend functions |

### Routing

**Current Approach:** No client-side router

- All content lives in `indexMVP.html`
- Navigation handled by showing/hiding sections via JavaScript
- Netlify catch-all redirect to `indexMVP.html`

---

## 3. Hosting & Deployment

### Deployment Configuration

| File | Platform | Purpose |
|------|----------|---------|
| `netlify.toml` | Netlify | Frontend & functions deployment |
| Railway Dashboard | Railway | API proxy configuration |

### Hosting Platforms

| Component | Platform | URL |
|-----------|----------|-----|
| Frontend | Netlify | https://i-love-miami.netlify.app |
| API Proxy | Railway | https://reliable-warmth-production-d382.up.railway.app |
| Functions | Netlify Functions | Serverless |
| Database | Supabase | Hosted PostgreSQL |

### Netlify Configuration (`netlify.toml`)

```toml
[build]
  functions = "backend/functions"
  publish = "."

[build.environment]
  NODE_VERSION = "18"

[dev]
  port = 3001
  functions = "backend/functions"

[[redirects]]
  from = "/api/maps/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to = "/indexMVP.html"
  status = 200

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "SAMEORIGIN"
    X-XSS-Protection = "1; mode=block"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

### PWA Configuration

**Service Worker:** `service-worker.js`
- Cache-First for assets
- Network-First for API calls
- Offline support via `offline.html`

**Manifest:** `manifest.json`
- App name: "LinkMia - Miami Airport Transfers"
- Display: standalone
- Theme color: #FF6B35

---

## 4. Styling

### CSS Approach

**Pure CSS with CSS Variables** - No Tailwind, SCSS, or styled-components.

### Design System (`css/style.css`)

#### Color Palette

```css
/* Primary Colors */
--primary-gradient-start: #FF9933;
--primary-gradient-end: #FF5733;
--primary: #FF9500;
--secondary: #3B82F6;

/* Status Colors */
--success: #32D74B;
--error: #FF453A;
--warning: #FFD60A;

/* Dark Theme */
--background-primary: #1a1a1a;
--background-secondary: #1C1C1E;
--surface-primary: #2C2C2E;
--surface-secondary: #3A3A3C;

/* Text Colors */
--text-primary: #FFFFFF;
--text-secondary: #8E8E93;
```

#### Spacing System (4px Grid)

```css
--spacing-xs: 4px;
--spacing-sm: 8px;
--spacing-md: 16px;
--spacing-lg: 24px;
--spacing-xl: 32px;
--spacing-2xl: 48px;
```

#### Typography

```css
--font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-size-xs: 12px;
--font-size-sm: 14px;
--font-size-md: 16px;
--font-size-lg: 18px;
--font-size-xl: 20px;
--font-size-2xl: 24px;
--font-size-3xl: 28px;
```

#### Border Radius

```css
--radius-sm: 4px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;
--radius-full: 9999px;
```

#### Transitions

```css
--transition-fast: 0.075s ease;
--transition-base: 0.2s ease;
--transition-slow: 0.3s ease;
--transition-slower: 0.4s ease;
```

### Design Characteristics

- **Mobile-first** responsive design
- **Dark theme** optimized for luxury/premium feel
- **iOS-inspired** UI components
- **Flexbox/Grid** for layout
- **Custom shadow system** for depth

---

## 5. Extensibility Assessment

### Feature Difficulty Matrix

| Feature | Difficulty | Time Estimate | Dependencies |
|---------|------------|---------------|--------------|
| Tab-based navigation | Easy | 2-3 hours | None |
| User authentication UI | Easy | 3-4 hours | Already configured |
| Feed/posts feature | Moderate | 1-2 days | New DB tables |
| Real-time chat | Moderate-High | 2-4 days | New DB tables, real-time |
| Database integration | Already Done | N/A | Supabase configured |

### Detailed Assessments

#### a) Tab-Based Navigation (3 tabs at bottom)

**Difficulty:** Easy

**Reasoning:** The current SPA structure supports this well. Requires:
1. Fixed bottom navigation bar (CSS)
2. Container divs for each tab's content (HTML)
3. JavaScript to toggle visibility between tabs

**No new dependencies required.**

#### b) User Authentication (email/password login)

**Difficulty:** Easy - Already Implemented!

**Reasoning:** Supabase Auth is already configured in `supabase.js`. Requires:
1. Login/signup UI forms
2. Wire up to existing Supabase auth methods
3. Protected route/content logic

**Full documentation available in `AUTH_IMPLEMENTATION_GUIDE.md`.**

#### c) Feed/Posts Feature

**Difficulty:** Moderate

**Requirements:**
1. New database table (`posts`) in Supabase
2. New JavaScript module for feed CRUD operations
3. UI components for post display/creation
4. Real-time subscriptions (Supabase supports this natively)

#### d) Real-Time Chat Feature

**Difficulty:** Moderate-High

**Requirements:**
1. New tables: `conversations`, `messages`
2. Supabase real-time subscriptions
3. Chat UI components
4. Message read receipts
5. Optional: Push notifications, encryption

**Note:** Supabase's built-in real-time features make this achievable without additional infrastructure.

#### e) Database Integration

**Difficulty:** Already Done!

**Status:** Supabase PostgreSQL is fully integrated with:
- Complete schema for users, bookings, trips
- Real-time subscription support
- CRUD helper functions in `supabase.js`

---

## 6. Recommendations

### Transformation Strategy Options

#### Option A: Stay Vanilla (Recommended for Speed)

Keep the current stack and add tabs/features incrementally.

**Pros:**
- No migration needed
- Faster to implement
- No build process complexity
- Smaller bundle size

**Cons:**
- May get complex as features grow
- No component reusability
- Manual state management

#### Option B: Migrate to React/Next.js

Rebuild with a component-based framework.

**Pros:**
- Better for complex apps
- Easier state management
- Component reusability
- Large ecosystem

**Cons:**
- Full rewrite required
- 1-2 weeks of work
- Learning curve if unfamiliar

### Recommendation: Option A (Vanilla Enhancement)

Given the current codebase maturity and the specific features needed (tabs, feed, chat), staying with vanilla JS is the faster path. The features you want to add don't require the complexity of a framework.

---

## 7. Implementation Guide

### New Files to Create

```
js/
├── router.js                  # Tab navigation controller
├── feed/
│   ├── feed-service.js        # Feed CRUD operations
│   └── feed-ui.js             # Feed rendering
├── chat/
│   ├── chat-service.js        # Chat real-time logic
│   └── chat-ui.js             # Chat rendering
└── auth/
    ├── auth-ui.js             # Login/signup forms
    └── auth-guard.js          # Protected content logic

css/
├── tabs.css                   # Bottom navigation styles
├── feed.css                   # Feed component styles
└── chat.css                   # Chat component styles
```

### Files to Modify

| File | Changes |
|------|---------|
| `indexMVP.html` | Add tab containers, bottom nav, login modal |
| `css/style.css` | Import new CSS files, layout adjustments |
| `supabase.js` | Add feed/chat/message CRUD methods |
| `database/linkmia-schema.sql` | Add posts, messages, conversations tables |

---

### Step 1: Add Tab Navigation Structure

**Modify `indexMVP.html`:**

```html
<!-- App Container with Tab Content -->
<main class="app-container">
  <!-- Tab 1: Profile (existing booking UI) -->
  <div id="tab-profile" class="tab-content active">
    <!-- Move existing booking UI here -->
  </div>

  <!-- Tab 2: Feed -->
  <div id="tab-feed" class="tab-content hidden">
    <header class="tab-header">
      <h1>Feed</h1>
    </header>
    <div id="feed-container"></div>
  </div>

  <!-- Tab 3: Chat -->
  <div id="tab-chat" class="tab-content hidden">
    <header class="tab-header">
      <h1>Messages</h1>
    </header>
    <div id="chat-container"></div>
  </div>
</main>

<!-- Fixed Bottom Navigation -->
<nav class="bottom-nav" id="bottom-nav">
  <button class="nav-tab active" data-tab="profile">
    <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
    </svg>
    <span class="nav-label">Profile</span>
  </button>
  <button class="nav-tab" data-tab="feed">
    <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
    </svg>
    <span class="nav-label">Feed</span>
  </button>
  <button class="nav-tab" data-tab="chat">
    <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
    </svg>
    <span class="nav-label">Chat</span>
  </button>
</nav>
```

---

### Step 2: Create Tab CSS

**Create `css/tabs.css`:**

```css
/* Bottom Navigation Bar */
.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 70px;
  background: var(--surface-primary);
  display: flex;
  justify-content: space-around;
  align-items: center;
  border-top: 1px solid var(--border-color);
  padding-bottom: env(safe-area-inset-bottom);
  z-index: 1000;
}

.nav-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  padding: var(--spacing-sm) var(--spacing-md);
  transition: color var(--transition-base);
  min-width: 64px;
}

.nav-tab:hover {
  color: var(--text-primary);
}

.nav-tab.active {
  color: var(--primary);
}

.nav-icon {
  width: 24px;
  height: 24px;
}

.nav-label {
  font-weight: 500;
}

/* Tab Content Areas */
.app-container {
  padding-bottom: 90px; /* Space for bottom nav + safe area */
}

.tab-content {
  min-height: calc(100vh - 90px);
}

.tab-content.hidden {
  display: none;
}

.tab-header {
  padding: var(--spacing-lg);
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 100;
}

.tab-header h1 {
  font-size: var(--font-size-xl);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

/* Hide bottom nav on desktop if needed */
@media (min-width: 768px) {
  .bottom-nav {
    /* Keep visible or hide based on preference */
    /* display: none; */
  }
}
```

---

### Step 3: Create Router Module

**Create `js/router.js`:**

```javascript
/**
 * Tab Router - Handles navigation between app tabs
 */
class TabRouter {
  constructor() {
    this.currentTab = 'profile';
    this.tabHistory = ['profile'];
    this.onTabChange = null;
    this.init();
  }

  init() {
    // Bind click handlers to nav tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.tab);
      });
    });

    // Handle browser back button
    window.addEventListener('popstate', (event) => {
      if (event.state && event.state.tab) {
        this.switchTab(event.state.tab, false);
      }
    });

    // Set initial state
    history.replaceState({ tab: 'profile' }, '', '');
  }

  switchTab(tabName, addToHistory = true) {
    if (tabName === this.currentTab) return;

    // Update tab content visibility
    document.querySelectorAll('.tab-content').forEach(content => {
      const isTarget = content.id === `tab-${tabName}`;
      content.classList.toggle('hidden', !isTarget);
      content.classList.toggle('active', isTarget);
    });

    // Update nav button states
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update history
    if (addToHistory) {
      history.pushState({ tab: tabName }, '', `#${tabName}`);
      this.tabHistory.push(tabName);
    }

    const previousTab = this.currentTab;
    this.currentTab = tabName;

    // Fire callback if set
    if (this.onTabChange) {
      this.onTabChange(tabName, previousTab);
    }

    // Scroll to top of new tab
    window.scrollTo(0, 0);
  }

  getCurrentTab() {
    return this.currentTab;
  }

  goBack() {
    if (this.tabHistory.length > 1) {
      this.tabHistory.pop();
      const previousTab = this.tabHistory[this.tabHistory.length - 1];
      this.switchTab(previousTab, false);
    }
  }
}

// Export for use
window.TabRouter = TabRouter;

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.router = new TabRouter();

  // Optional: Handle tab changes
  window.router.onTabChange = (newTab, oldTab) => {
    console.log(`Switched from ${oldTab} to ${newTab}`);

    // Load tab-specific content
    if (newTab === 'feed' && typeof loadFeed === 'function') {
      loadFeed();
    }
    if (newTab === 'chat' && typeof loadConversations === 'function') {
      loadConversations();
    }
  };
});
```

---

### Step 4: Database Schema Updates

**Add to `database/linkmia-schema.sql`:**

```sql
-- ============================================
-- FEED/POSTS TABLES
-- ============================================

-- Posts table for the feed
CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  post_type VARCHAR(50) DEFAULT 'standard', -- standard, announcement, promotion
  likes_count INT DEFAULT 0,
  comments_count INT DEFAULT 0,
  is_pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Post likes
CREATE TABLE post_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- Post comments
CREATE TABLE post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CHAT/MESSAGING TABLES
-- ============================================

-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_1 UUID REFERENCES customers(id) ON DELETE CASCADE,
  participant_2 UUID REFERENCES customers(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_1, participant_2)
);

-- Messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text', -- text, image, system
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_conversations_participants ON conversations(participant_1, participant_2);

-- ============================================
-- ENABLE REAL-TIME
-- ============================================

ALTER TABLE posts REPLICA IDENTITY FULL;
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Posts: Anyone can read, only owner can write
CREATE POLICY "Posts are viewable by everyone" ON posts
  FOR SELECT USING (true);

CREATE POLICY "Users can create their own posts" ON posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own posts" ON posts
  FOR UPDATE USING (auth.uid() = user_id);

-- Messages: Only participants can access
CREATE POLICY "Users can view their messages" ON messages
  FOR SELECT USING (
    sender_id = auth.uid() OR
    conversation_id IN (
      SELECT id FROM conversations
      WHERE participant_1 = auth.uid() OR participant_2 = auth.uid()
    )
  );

CREATE POLICY "Users can send messages" ON messages
  FOR INSERT WITH CHECK (sender_id = auth.uid());

-- Conversations: Only participants can access
CREATE POLICY "Users can view their conversations" ON conversations
  FOR SELECT USING (participant_1 = auth.uid() OR participant_2 = auth.uid());
```

---

### Step 5: Update Supabase Client

**Add to `supabase.js`:**

```javascript
// ============================================
// FEED METHODS
// ============================================

async function getPosts(limit = 20, offset = 0) {
  const { data, error } = await supabaseClient
    .from('posts')
    .select(`
      *,
      user:customers(id, name, avatar_url)
    `)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data;
}

async function createPost(content, imageUrl = null) {
  const user = await supabaseClient.auth.getUser();
  if (!user.data.user) throw new Error('Not authenticated');

  const { data, error } = await supabaseClient
    .from('posts')
    .insert({
      user_id: user.data.user.id,
      content,
      image_url: imageUrl
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function likePost(postId) {
  const user = await supabaseClient.auth.getUser();
  if (!user.data.user) throw new Error('Not authenticated');

  const { error } = await supabaseClient
    .from('post_likes')
    .insert({
      post_id: postId,
      user_id: user.data.user.id
    });

  if (error && error.code !== '23505') throw error; // Ignore duplicate
  return true;
}

function subscribeToFeed(callback) {
  return supabaseClient
    .channel('public:posts')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'posts' },
      (payload) => callback(payload.new)
    )
    .subscribe();
}

// ============================================
// CHAT METHODS
// ============================================

async function getConversations() {
  const user = await supabaseClient.auth.getUser();
  if (!user.data.user) throw new Error('Not authenticated');

  const { data, error } = await supabaseClient
    .from('conversations')
    .select(`
      *,
      participant_1_data:customers!participant_1(id, name, avatar_url),
      participant_2_data:customers!participant_2(id, name, avatar_url)
    `)
    .or(`participant_1.eq.${user.data.user.id},participant_2.eq.${user.data.user.id}`)
    .order('last_message_at', { ascending: false });

  if (error) throw error;
  return data;
}

async function getMessages(conversationId, limit = 50) {
  const { data, error } = await supabaseClient
    .from('messages')
    .select(`
      *,
      sender:customers(id, name, avatar_url)
    `)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data;
}

async function sendMessage(conversationId, content) {
  const user = await supabaseClient.auth.getUser();
  if (!user.data.user) throw new Error('Not authenticated');

  const { data, error } = await supabaseClient
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: user.data.user.id,
      content
    })
    .select()
    .single();

  if (error) throw error;

  // Update conversation last_message_at
  await supabaseClient
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return data;
}

function subscribeToMessages(conversationId, callback) {
  return supabaseClient
    .channel(`messages:${conversationId}`)
    .on('postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`
      },
      (payload) => callback(payload.new)
    )
    .subscribe();
}

// Export new methods
window.SupabaseHelpers = {
  ...window.SupabaseHelpers,
  getPosts,
  createPost,
  likePost,
  subscribeToFeed,
  getConversations,
  getMessages,
  sendMessage,
  subscribeToMessages
};
```

---

### Summary: Implementation Checklist

| Task | Priority | Status |
|------|----------|--------|
| Create `css/tabs.css` | High | Pending |
| Create `js/router.js` | High | Pending |
| Update `indexMVP.html` with tab structure | High | Pending |
| Update database schema | High | Pending |
| Update `supabase.js` with new methods | High | Pending |
| Create `js/feed/feed-service.js` | Medium | Pending |
| Create `js/feed/feed-ui.js` | Medium | Pending |
| Create `css/feed.css` | Medium | Pending |
| Create `js/chat/chat-service.js` | Medium | Pending |
| Create `js/chat/chat-ui.js` | Medium | Pending |
| Create `css/chat.css` | Medium | Pending |
| Create `js/auth/auth-ui.js` | Low | Pending |
| Create `js/auth/auth-guard.js` | Low | Pending |

---

## Quick Reference

### Key Files

| Purpose | File |
|---------|------|
| Main App | `indexMVP.html` |
| Styles | `css/style.css` |
| Database Client | `supabase.js` |
| API Config | `api-config.js` |
| Pricing Logic | `pricing.js` |
| Address Search | `autocomplete.js` |
| Backend Functions | `backend/functions/` |
| API Proxy | `backend/api-proxy/server.js` |

### Environment Variables Required

```env
# Google Maps
GOOGLE_MAPS_API_KEY=your_key

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# Stripe
STRIPE_SECRET_KEY=sk_xxx
STRIPE_PUBLISHABLE_KEY=pk_xxx

# Twilio
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+1xxx

# SendGrid
SENDGRID_API_KEY=your_key
```

### Useful Commands

```bash
# Start development server
npm run dev

# Start production server
npm start

# Deploy to Netlify
git push origin main

# Run Supabase migrations
# (Execute SQL in Supabase dashboard)
```

---

*Last updated: December 2024*
