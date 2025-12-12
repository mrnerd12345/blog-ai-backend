import openai from "./openaiClient.js";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OpenAI } = require("openai");
const Stripe = require("stripe");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret_in_env";

// Stripe config
const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

// Admin email (for admin routes)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

// ---- PLAN CONFIG ----
const PLANS = {
  free: {
    name: "Free",
    maxTokensPerMonth: parseInt(process.env.FREE_MAX_TOKENS_PER_MONTH || "20000")
  },
  pro: {
    name: "Pro",
    maxTokensPerMonth: parseInt(process.env.PRO_MAX_TOKENS_PER_MONTH || "200000")
  },
  premium: {
    name: "Premium",
    maxTokensPerMonth: parseInt(process.env.PREMIUM_MAX_TOKENS_PER_MONTH || "1000000")
  }
};

// ---- OpenAI client ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---- Helpers ----
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).length / 0.75);
}

function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function updateUserPlan(id, newPlan) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET plan = ? WHERE id = ?`,
      [newPlan, id],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function addUsedTokens(id, amount) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET usedTokens = usedTokens + ? WHERE id = ?`,
      [amount, id],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function saveArticle(userId, topic, content) {
  return new Promise((resolve, reject) => {
    const createdAt = new Date().toISOString();
    db.run(
      `INSERT INTO articles (userId, topic, content, createdAt) VALUES (?, ?, ?, ?)`,
      [userId, topic, content, createdAt],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getUserHistory(userId, limit = 20) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, topic, content, createdAt
       FROM articles
       WHERE userId = ?
       ORDER BY datetime(createdAt) DESC
       LIMIT ?`,
      [userId, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, email, plan, usedTokens
       FROM users
       ORDER BY id ASC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function auth(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "Missing token" });

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "Invalid token format" });
  }
  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    req.user = decoded; // { id, email }
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

// ---- MIDDLEWARE ORDER ----
app.use(cors());

// Stripe webhook BEFORE express.json()
if (stripe && stripeWebhookSecret) {
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    (req, res) => {
      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          stripeWebhookSecret
        );
      } catch (err) {
        console.error("Stripe webhook signature error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const metadata = session.metadata || {};
        const userId = metadata.userId;
        const plan = metadata.plan;

        console.log("Checkout completed for user", userId, "plan", plan);

        if (userId && (plan === "pro" || plan === "premium")) {
          updateUserPlan(userId, plan)
            .then(() => {
              console.log(`User ${userId} upgraded to ${plan}`);
            })
            .catch((err) => {
              console.error("Failed to update user plan:", err);
            });
        }
      }

      res.json({ received: true });
    }
  );
}

// JSON parser for everything else
app.use(express.json());

// ---- ROUTES ----

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Blog AI backend with auth, Stripe, history, admin" });
});

// REGISTER
app.post("/register", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  const hashed = bcrypt.hashSync(password, 10);

  db.run(
    `INSERT INTO users (email, password, plan, usedTokens) VALUES (?, ?, 'free', 0)`,
    [email.toLowerCase(), hashed],
    function (err) {
      if (err) return res.status(400).json({ error: "Email already exists" });

      res.json({ message: "Registration successful" });
    }
  );
});

// LOGIN
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE email = ?`,
    [email.toLowerCase()],
    (err, user) => {
      if (!user) return res.status(400).json({ error: "Invalid credentials" });

      const valid = bcrypt.compareSync(password, user.password);
      if (!valid) return res.status(400).json({ error: "Invalid credentials" });

      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
        expiresIn: "7d"
      });

      res.json({
        message: "Login successful",
        token,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          usedTokens: user.usedTokens
        }
      });
    }
  );
});

// CURRENT USER
app.get("/me", auth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const planData = PLANS[user.plan] || PLANS.free;

    res.json({
      id: user.id,
      email: user.email,
      plan: user.plan,
      usedTokens: user.usedTokens,
      maxTokensPerMonth: planData.maxTokensPerMonth,
      isAdmin: ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
    });
  } catch (err) {
    console.error("/me error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// CHANGE PLAN (manual)
app.post("/change-plan", auth, async (req, res) => {
  const { newPlan } = req.body;

  if (!["free", "pro", "premium"].includes(newPlan)) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  try {
    await updateUserPlan(req.user.id, newPlan);
    res.json({ message: `Plan updated to ${newPlan}` });
  } catch (err) {
    console.error("/change-plan error:", err);
    res.status(500).json({ error: "Failed to change plan" });
  }
});

// CREATE STRIPE CHECKOUT SESSION
app.post("/create-checkout-session", auth, async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_PRICE_PRO || !process.env.STRIPE_PRICE_PREMIUM) {
      return res
        .status(500)
        .json({ error: "Stripe is not configured on the server." });
    }

    const { plan, successUrl, cancelUrl } = req.body;

    if (!["pro", "premium"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const priceId =
      plan === "pro"
        ? process.env.STRIPE_PRICE_PRO
        : process.env.STRIPE_PRICE_PREMIUM;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: successUrl || "http://localhost:5500/frontend/success.html",
      cancel_url: cancelUrl || "http://localhost:5500/frontend/cancel.html",
      customer_email: user.email,
      metadata: {
        userId: user.id.toString(),
        plan
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("/create-checkout-session error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// USER HISTORY
app.get("/history", auth, async (req, res) => {
  try {
    const list = await getUserHistory(req.user.id, 50);
    res.json({ history: list });
  } catch (err) {
    console.error("/history error:", err);
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ADMIN: LIST USERS
app.get("/admin/users", auth, async (req, res) => {
  try {
    const me = await getUserById(req.user.id);
    if (!me) return res.status(404).json({ error: "User not found" });

    const isAdmin =
      ADMIN_EMAIL && me.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const users = await getAllUsers();
    res.json({ users });
  } catch (err) {
    console.error("/admin/users error:", err);
    res.status(500).json({ error: "Failed to load users" });
  }
});

// GENERATE ARTICLE
app.post("/generate", auth, async (req, res) => {
  try {
    const { topic, targetWords = 1200 } = req.body;

    if (!topic)
      return res.status(400).json({ error: "Topic is required" });

    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const plan = PLANS[user.plan] || PLANS.free;

    const inputTokens = estimateTokens(topic);
    const outputTokens = Math.max(targetWords * 2, 200);
    const totalTokens = inputTokens + outputTokens;

    if (user.usedTokens + totalTokens > plan.maxTokensPerMonth) {
      return res.status(402).json({
        error: "Token limit reached for plan",
        plan: user.plan,
        usedTokens: user.usedTokens,
        maxTokens: plan.maxTokensPerMonth
      });
    }

    const systemPrompt =
      "You are an expert SEO blog writer. Write structured, helpful content with headings and subheadings.";
    const userPrompt = `
Topic: ${topic}
Target length: about ${targetWords} words.
Write a full blog article with intro, sections, and conclusion.
    `;

    const completion = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_output_tokens: outputTokens
    });

    let article = "(No content)";
    try {
      article = completion.output[0].content[0].text;
    } catch (e) {
      console.error("OpenAI parsing error:", e);
      article = "Failed to parse OpenAI response.";
    }

    await addUsedTokens(user.id, totalTokens);
    await saveArticle(user.id, topic, article);

    res.json({
      article,
      stats: {
        inputTokens,
        outputTokens,
        totalTokens,
        usedTokensAfter: user.usedTokens + totalTokens,
        maxTokensPerMonth: plan.maxTokensPerMonth
      }
    });
  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({
      error: "OpenAI error",
      details: err?.error?.message || err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Blog AI backend running on port ${PORT}`);
});

app.post("/generate-article", async (req, res) => {
  try {
    const { topic, tone = "professional", length = "medium" } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const prompt = `
Write a ${length} blog article about "${topic}".
Tone: ${tone}.
Include:
- SEO-friendly title
- Introduction
- Subheadings
- Conclusion
Do NOT include markdown symbols.
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 900
    });

    res.json({
      title: response.choices[0].message.content.split("\n")[0],
      content: response.choices[0].message.content
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Article generation failed" });
  }
});
