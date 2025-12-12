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
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME";

/* =========================
   CORS (FIXED – SINGLE SOURCE)
========================= */
const corsOptions = {
  origin: "http://localhost:5500",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   Stripe (optional)
========================= */
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* =========================
   Plans
========================= */
const PLANS = {
  free: { maxTokens: 20000 },
  pro: { maxTokens: 200000 },
  premium: { maxTokens: 1000000 }
};

/* =========================
   Auth Middleware
========================= */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });

  try {
    const token = header.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
  }
}

/* =========================
   Root
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Blog AI backend running" });
});

/* =========================
   Register
========================= */
app.post("/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing fields" });

  const hash = bcrypt.hashSync(password, 10);

  db.run(
    `INSERT INTO users (email, password, plan, usedTokens)
     VALUES (?, ?, 'free', 0)`,
    [email.toLowerCase(), hash],
    err => {
      if (err) return res.status(400).json({ error: "User exists" });
      res.json({ message: "Registered" });
    }
  );
});

/* =========================
   Login
========================= */
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE email = ?`,
    [email.toLowerCase()],
    (err, user) => {
      if (!user || !bcrypt.compareSync(password, user.password))
        return res.status(400).json({ error: "Invalid credentials" });

      const token = jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      res.json({ token });
    }
  );
});

/* =========================
   Generate Article (NO AUTH)
========================= */
app.post("/generate-article", async (req, res) => {
  try {
    const { topic, tone = "professional", length = "medium" } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });

    const prompt = `
Write a ${length} blog article about "${topic}".
Tone: ${tone}.
Include:
- SEO title
- Introduction
- Subheadings
- Conclusion
Plain text only.
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      max_output_tokens: 900
    });

    const text = response.output[0].content[0].text;

    res.json({
      title: text.split("\n")[0],
      content: text
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Generation failed" });
  }
});

/* =========================
   Generate Article (AUTH)
========================= */
app.post("/generate", auth, async (req, res) => {
  try {
    const { topic, targetWords = 800 } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });

    db.get(
      `SELECT * FROM users WHERE id = ?`,
      [req.user.id],
      async (err, user) => {
        if (!user) return res.status(404).json({ error: "User not found" });

        const plan = PLANS[user.plan] || PLANS.free;
        const estimatedTokens = targetWords * 2;

        if (user.usedTokens + estimatedTokens > plan.maxTokens) {
          return res.status(402).json({ error: "Token limit reached" });
        }

        const response = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: `Write a ${targetWords}-word blog article about ${topic}.`,
          max_output_tokens: estimatedTokens
        });

        const article = response.output[0].content[0].text;

        db.run(
          `UPDATE users SET usedTokens = usedTokens + ? WHERE id = ?`,
          [estimatedTokens, user.id]
        );

        db.run(
          `INSERT INTO articles (userId, topic, content, createdAt)
           VALUES (?, ?, ?, datetime('now'))`,
          [user.id, topic, article]
        );

        res.json({ article });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Generation failed" });
  }
});

/* =========================
   Start Server
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
