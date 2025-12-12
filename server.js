import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OpenAI } from "openai";
import Stripe from "stripe";
import db from "./database.js";

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret_in_env";

/* =====================
   CONFIG
===================== */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

// Stripe
const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Plans
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

/* =====================
   HELPERS
===================== */

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).length / 0.75);
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });

  const [type, token] = header.split(" ");
  if (type !== "Bearer") {
    return res.status(401).json({ error: "Invalid token format" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

/* =====================
   MIDDLEWARE
===================== */

app.use(cors());

// Stripe webhook must come BEFORE json()
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
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const { userId, plan } = session.metadata || {};

        if (userId && ["pro", "premium"].includes(plan)) {
          db.run(`UPDATE users SET plan=? WHERE id=?`, [plan, userId]);
        }
      }

      res.json({ received: true });
    }
  );
}

app.use(express.json());

/* =====================
   ROUTES
===================== */

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Blog AI backend with auth, Stripe, history, admin"
  });
});

/* ---------- AUTH ---------- */

app.post("/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  const hashed = bcrypt.hashSync(password, 10);

  db.run(
    `INSERT INTO users (email, password, plan, usedTokens)
     VALUES (?, ?, 'free', 0)`,
    [email.toLowerCase(), hashed],
    err => {
      if (err) return res.status(400).json({ error: "Email exists" });
      res.json({ message: "Registration successful" });
    }
  );
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE email=?`,
    [email.toLowerCase()],
    (err, user) => {
      if (!user) return res.status(400).json({ error: "Invalid credentials" });

      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      res.json({ token });
    }
  );
});

/* ---------- USER ---------- */

app.get("/me", auth, (req, res) => {
  db.get(
    `SELECT id,email,plan,usedTokens FROM users WHERE id=?`,
    [req.user.id],
    (err, user) => {
      if (!user) return res.status(404).json({ error: "User not found" });

      const planData = PLANS[user.plan] || PLANS.free;

      res.json({
        ...user,
        maxTokensPerMonth: planData.maxTokensPerMonth,
        isAdmin:
          ADMIN_EMAIL &&
          user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
      });
    }
  );
});

/* ---------- AI GENERATION (AUTH REQUIRED) ---------- */

app.post("/generate", auth, async (req, res) => {
  const { topic, targetWords = 1200 } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic required" });

  db.get(`SELECT * FROM users WHERE id=?`, [req.user.id], async (err, user) => {
    if (!user) return res.status(404).json({ error: "User not found" });

    const plan = PLANS[user.plan] || PLANS.free;
    const tokens = estimateTokens(topic) + targetWords * 2;

    if (user.usedTokens + tokens > plan.maxTokensPerMonth) {
      return res.status(402).json({ error: "Token limit reached" });
    }

    const completion = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Write a ${targetWords}-word SEO blog article about "${topic}".`
    });

    const article = completion.output[0].content[0].text;

    db.run(
      `UPDATE users SET usedTokens=usedTokens+? WHERE id=?`,
      [tokens, user.id]
    );
    db.run(
      `INSERT INTO articles (userId,topic,content,createdAt)
       VALUES (?,?,?,datetime('now'))`,
      [user.id, topic, article]
    );

    res.json({ article });
  });
});

/* ---------- PUBLIC DEMO ENDPOINT ---------- */

app.post("/generate-article", async (req, res) => {
  try {
    const { topic, tone = "professional", length = "medium" } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });

    const prompt = `
Write a ${length} blog article about "${topic}".
Tone: ${tone}.
Include a title, intro, sections, and conclusion.
No markdown.
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
    res.status(500).json({ error: "Generation failed" });
  }
});

/* =====================
   START SERVER (LAST)
===================== */

app.listen(PORT, () => {
  console.log(`Blog AI backend running on port ${PORT}`);
});
