if(process.env.NODE_ENV !== "production") {
  require("dotenv").config()
}

const express = require("express");
const cors = require("cors");
const app = express();

const { z } = require("zod");
const { createPool } = require("mysql2") 
const bcrypt = require("bcrypt");
const passport = require("passport");
const flash = require("express-flash");
const session = require("express-session");
const initialisePassport = require("./passport-config")
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);
const OpenAI = require("openai");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const nodemailer = require('nodemailer');
const helmet = require("helmet");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const reportSchema = z.object({
  income_analysis: z.object({
    role_level: z.string(),
    is_underpaid: z.boolean(),
    current_market_range: z.string(),
    estimated_fair_salary: z.string(),
    income_gap: z.string()
  }),

  best_next_role: z.object({
    target_role: z.string(),
    reasoning: z.string(),
    salary_range: z.string(),
    expected_salary_jump: z.string()
  }),

  "90_day_transition_plan": z.array(z.string()),

  cv_upgrade: z.object({
    problems: z.array(z.string()),
    fixes: z.array(z.string())
  }),

  skills_gap: z.array(z.string()),

  salary_increase_strategy: z.object({
    can_negotiate_current_job: z.boolean(),
    what_to_say: z.string(),
    strategy: z.string()
  }),

  application_strategy: z.array(z.string()),

  transferable_skills_match: z.array(
    z.object({
      current_skill: z.string(),
      maps_to: z.string(),
      market_value: z.string()
    })
  ),

  job_titles_to_search: z.array(z.string()),

  market_demand: z.object({
    score: z.number(),
    explanation: z.string()
  }),

  biggest_income_leak: z.string(),

  fastest_salary_path: z.object({
    method: z.string(),
    timeline: z.string(),
    difficulty: z.string()
  }),

  final_summary: z.object({
    current_path: z.string(),
    optimized_path: z.string(),
    income_projection: z.string()
  })
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    const sig = req.headers["stripe-signature"];

    let event;

    try {

      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

    } catch (err) {

      console.log("Webhook signature failed:", err.message);

      return res.status(400).send(
        `Webhook Error: ${err.message}`
      );
    }

    // PAYMENT SUCCESS
    if (event.type === "checkout.session.completed") {

      const session = event.data.object;


      const customerEmail =
  session.customer_details?.email ||
  session.customer_email;

      try {

        const userId = session.metadata.userId;
const reportId = session.metadata.reportId;

const [report2] = await pool.query(
  "SELECT user_id FROM income_reports WHERE id = ?",
  [reportId]
);

if (!report2.length) {
  console.log("Report not found");
  return res.status(200).json({ received: true });
}

if (report2[0].user_id !== Number(userId)) {
  console.log("User mismatch detected");
  return res.status(200).json({ received: true });
}

        await pool.query(
          `
          UPDATE income_reports
          SET paid = true
          WHERE id = ? AND user_id = ?
          `,
          [reportId, userId]
        );

        const [reports] = await pool.query(
          `
          SELECT receipt_sent
          FROM income_reports
          WHERE id = ?
          `,
          [reportId]
        );

        const report = reports[0];

        const [updated] = await pool.query(
          `
          UPDATE income_reports
          SET receipt_sent = true
          WHERE id = ? AND receipt_sent = false
          `,
          [reportId]
        );
        
        if (updated.affectedRows > 0) {
          await sendReceipt(customerEmail);
        }

        console.log(
          "Payment verified via webhook"
        );

      } catch (e) {

        console.log(
          "Webhook DB error:",
          e
        );
      }
    }

    res.json({ received: true });
  }
);


//stripe login
//stripe listen --forward-to localhost:5000/stripe-webhook

app.set("trust proxy", 1);
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      "https://risevexa-frontend-zk5j.vercel.app/",
    "https://risevexa.com"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, 
  })
);
app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);
app.use(express.json({
  limit: "2mb"
}));
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production"
  ? "none"
  : "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
});

app.post("/create-checkout-session", checkoutLimiter ,async (req, res) => {
  try {

    const { reportId } = req.body;

    if (!Number.isInteger(Number(reportId))) {
      return res.status(400).json({
        error: "Invalid report ID"
      });
    }


    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userEmail = req.user.email;



    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: userEmail,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "Career Positioning Report",
              description: "Full income upgrade analysis"
            },
            unit_amount: process.env.PRICE, 
          },
          quantity: 1,
        },
      ],

      metadata: {
        reportId: String(reportId),
  userId: String(req.user.id)
      },

      

      success_url: `${process.env.CLIENT_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}&reportId=${reportId}`,
      cancel_url: `${process.env.CLIENT_URL}/analysis`,
    });

    res.json({ url: session.url });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Payment failed" });
  }
});


app.get("/verify-payment", async (req, res) => {

  try {

    if (!req.isAuthenticated()) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const userId = req.user.id;

    const { reportId } = req.query;

    const [rows] = await pool.query(
      `
      SELECT paid
      FROM income_reports
      WHERE id = ? AND user_id = ?
      `,
      [reportId, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Report not found"
      });
    }

    return res.json({
      paid: rows[0].paid
    });

  } catch (err) {

    console.log(err);

    res.status(500).json({
      error: "Verification failed"
    });
  }
});



app.get("/get-report", async (req, res) => {
  try {

    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const userId = req.user.id;

    const { id } = req.query;

    const [rows] = await pool.query(
      "SELECT * FROM income_reports WHERE id = ? AND user_id = ?",
      [id, userId]
    );

    if(rows.length === 0){
      return res.status(404).json({
        error: "Report not found"
      });
    }

    const report = rows[0];

    if(!report.paid){
      return res.status(403).json({
        error: "Report not paid"
      });
    }

    res.json(report);

  } catch(err){
    console.log(err);

    res.status(500).json({
      error: "Server error"
    });
  }
});

 

const getUserByEmail = async (email) => {
  const [rows] = await pool.query("SELECT * FROM users where email = ?", [email])
  return rows[0]
  }
  
  const getUserById = async (id) => {
  const [rows] = await pool.query("SELECT * FROM users where id = ?", [id])
  return rows[0]
  }
  

initialisePassport(passport, getUserByEmail, getUserById)



  app.post("/register", async (req, res, next) => {
  if (req.isAuthenticated()) {
    return res.status(403).json({ error: 'Already logged in' });
  }

  const { username, email, password } = req.body;


  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: "Password must be at least 8 characters"
    });
  }

  try {

    const [existingUsername] = await pool.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );

    if (existingUsername.length > 0) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    // Check if email exists
    const [existingEmail] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        error: "Email already exists"
      });
    }



    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, email, password) 
       VALUES (?, ?, ?)`,
      [username, email, hashedPassword]
    );

    const [userResult] = await pool.query(
      'SELECT * FROM users WHERE email = ?', 
      [email]
    );
    const user = userResult[0];

    if (!user) {
      return res.status(500).json({ error: "User not found after registration" });
    }

    req.logIn(user, async (err) => {
      if (err) {
        console.error("Login error after registration:", err);

        return res.status(500).json({
          error: "Login failed after registration"
        });
      }

      return res.json({ success: true, 
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
       });
    });

  } catch (e) {
    console.error('Error creating the account:', e);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
  })

  app.post("/log-in", async (req, res, next) => {
  if (req.isAuthenticated()) {
    return res.status(403).json({ error: "Already logged in" });
  }
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info ? info.message : "Invalid credentials" });
  
    req.logIn(user, async (err) => {
      if (err) return next(err);
  
  
      
      try {
        const lastLoginTime = new Date().toISOString().slice(0, 19).replace("T", " ");
        await pool.query("UPDATE users SET last_login = ? WHERE id = ?", [lastLoginTime, user.id]);
        
      } catch (e) {
        console.error("Error updating last login date:", e);
        return res.status(500).json({ error: "Database error" });
      }
  
      return res.json({ success: true, 
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
       });
    });
  })(req, res, next);
  });

  app.get("/auth-check", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ user: null });
    }
  
    return res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email
      }
    });
  });

  app.post("/logout", (req, res) => {
    req.logout((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        return res.json({ message: "Logged out successfully" });
      });
    });
  });

  app.post('/auth/google', async (req, res) => {
      try {
        const { token } = req.body;
    
        const ticket = await client.verifyIdToken({
          idToken: token,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
    
        const payload = ticket.getPayload();
    
        const { email, name, sub } = payload;
    
        const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
        let user = rows[0];
    
        if (!user) {
          await pool.query(
            "INSERT INTO users (email, username, google_id) VALUES (?, ?, ?)",
            [email, name, sub]
          );
          
          const [newUserRows] = await pool.query(
            "SELECT * FROM users WHERE email = ?",
            [email]
          );
          
          user = newUserRows[0];
        }
    
        req.logIn(user, (err) => {
          if (err) return res.status(500).json({ error: "Login failed" });
        
          return res.json({ success: true, 
            user: {
              id: user.id,
              username: user.username,
              email: user.email
            }
           });
        });
    
      } catch (err) {
        console.error("GOOGLE VERIFY FAILED:", err);
        res.status(401).json({
          error: "Invalid Google token",
          details: err.message
        });
      }
  });

    app.post("/analyze-career", async (req, res) => {
      try {
        const {
          role,
          experience,
          salary,
          targetRole,
          description,
          qualifications
        } = req.body;
    
        const prompt = `
    You are a career analyst AI.
    
    User data:
    - Current role: ${role}
    - Years of experience: ${experience}
    - Current salary: €${salary}
    - Desired role: ${targetRole || "Not specified"}
    - Work description: ${description}
    - Qualifications: ${qualifications || "Not provided"}
    
    Return a JSON response with:
    - role_level
    - estimated_market_salary_range
    - income_gap
    - missing_skills
    - next_steps
    `;
    
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a helpful career advisor." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
        });
    
        const aiText = response.choices[0].message.content;
    
        res.json({ result: aiText });
    
      } catch (err) {
        console.error("AI ERROR:", err);
        res.status(500).json({ error: "AI failed" });
      }
  });

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL,
      pass: process.env.EMAIL_PASS
    }
});

  const sendReceipt = async (email) => {
    try {

      const name = email.split('@')[0];
      if (!email) {
        return console.log("Email is required");
    }

    const now = new Date();
const date = now.toLocaleDateString("en-IE", {
  day: "2-digit",
  month: "long",
  year: "numeric"
});


    const html = `
   <div style="max-width:680px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#05070d;color:#e5e7eb;border-radius:18px;overflow:hidden;border:1px solid #1f2937;box-shadow:0 20px 60px rgba(0,0,0,0.6);">

  <!-- TOP BAR GLOW -->
  <div style="height:6px;background:linear-gradient(90deg,#00e5a8,#60a5fa,#a78bfa);"></div>

  <!-- HEADER -->
  <div style="padding:42px 30px 30px 30px;text-align:center;background:radial-gradient(circle at top,#0b1220,#05070d); border-radius: 18px;">

    <img 
      src="https://risevexa.com/risevexa-logo.png"
      alt="RiseVexa"
      style="width:150px;margin-bottom:18px;filter:drop-shadow(0 10px 30px rgba(0,229,168,0.2));"
    />

    <div style="display:inline-block;padding:6px 12px;border:1px solid #1f2937;border-radius:999px;font-size:12px;color:#00e5a8;margin-bottom:16px;">
      PAYMENT CONFIRMED
    </div>

    <h1 style="margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;">
      Your Career Report is Ready
    </h1>

    <p style="margin-top:10px;color:#9ca3af;font-size:14px;line-height:1.6;">
      We’ve analysed your profile, salary positioning, and market opportunities.
      Your personalised income strategy is now unlocked.
    </p>
  </div>

  <!-- BODY -->
  <div style="padding:0 40px 40px 40px;">

    <!-- MAIN CARD -->
    <div style="background:#0b1220;border:1px solid #1f2937;border-radius:16px;padding:22px;">

      <h3 style="margin:0 0 18px 0;font-size:14px;color:#9ca3af;letter-spacing:0.08em;text-transform:uppercase;">
        Receipt Details
      </h3>

      <div style="display:flex;justify-content:space-between;margin-bottom:14px;">
        <span style="color:#9ca3af;">Product</span>
        <span style="color:#ffffff;font-weight:500;">AI Income Optimization Report</span>
      </div>

      <div style="display:flex;justify-content:space-between;margin-bottom:14px;">
        <span style="color:#9ca3af;">Date</span>
        <span style="color:#ffffff;">${date}</span>
      </div>

      <div style="height:1px;background:#1f2937;margin:18px 0;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#9ca3af;">Total Paid</span>
        <span style="font-size:18px;font-weight:700;color:#00e5a8;">€14.99</span>
      </div>
    </div>

    <!-- VALUE SECTION -->
    <div style="margin-top:22px;padding:20px;border-radius:14px;background:linear-gradient(135deg,#0b1220,#0a0f1a);border:1px solid #1f2937;">

      <h3 style="margin:0 0 12px 0;color:#ffffff;font-size:15px;">
        What you just unlocked
      </h3>

      <div style="color:#9ca3af;font-size:13px;line-height:1.7;">
        • Real market salary comparison (EU/UK benchmarks)<br/>
        • Hidden income gaps in your current role<br/>
        • 90-day transition roadmap to higher-paying roles<br/>
        • CV rewrite strategy based on recruiter patterns<br/>
        • Negotiation script tailored to your profile
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-top:26px;">
      <a href="https://risevexa.com/dashboard"
         style="display:inline-block;padding:14px 26px;background:linear-gradient(90deg,#00e5a8,#22c55e);color:#04130f;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;box-shadow:0 10px 30px rgba(0,229,168,0.25);">
        Access Your Report
      </a>
    </div>

    <!-- SMALL NOTE -->
    <p style="margin-top:22px;font-size:12px;color:#6b7280;line-height:1.6;text-align:center;">
      Your report has been permanently saved to your account dashboard.
      You can revisit it anytime.
    </p>

  </div>

  <!-- FOOTER -->
  <div style="padding:22px 40px;background:#05070d;border-top:1px solid #1f2937;text-align:center;">

    <p style="margin:0;color:#6b7280;font-size:12px;">
      RiseVexa • AI Career Intelligence Platform
    </p>

    <p style="margin-top:6px;color:#374151;font-size:11px;">
      Secure payment processed. If this wasn’t you, contact support immediately.
    </p>
  </div>

</div>
    `


      

    const mailOptions = {
        from: process.env.EMAIL,
        to: email,
        subject: "AI Income Optimization Report",
        html: html
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Error sending email:", error);
        return;
      }
    console.log("Email sent:", info.response);
    });


    } catch(e) {
      console.log("An error occured while trying to send the receipt", e)
    }
  }


  const analysisLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many reports generated. Please try again later."
    }
  });

  const sendUserDataSchema = z.object({
    currentJob: z
      .string()
      .min(2)
      .max(120),
  
    yearsExperience: z
      .string()
      .min(1)
      .max(60),
  
    currentSalary: z
      .union([
        z.string(),
        z.number()
      ]),
  
    wishJob: z
      .string()
      .max(120)
      .optional()
      .or(z.literal("")),
  
    cv: z
      .string()
      .max(2500),
  
    qualifications: z
      .string()
      .max(1200)
      .optional()
      .or(z.literal(""))
  });

app.use("/send-user-data", analysisLimiter);

  app.post("/send-user-data", async (req, res) => {
    try {

      if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const userId = req.user.id;


      const [dailyUsage] = await pool.query(
        `
        SELECT COUNT(*) as total
        FROM income_reports
        WHERE user_id = ?
        AND created_at >= NOW() - INTERVAL 1 DAY
        `,
        [userId]
      );
      
      if (dailyUsage[0].total >= 5) {
        return res.status(429).json({
          error: "Daily analysis limit reached"
        });
      }


      const [recentRequest] = await pool.query(
        `
        SELECT created_at
        FROM income_reports
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [userId]
      );
      
      if (recentRequest.length > 0) {
      
        const lastRequest = new Date(recentRequest[0].created_at);
        const now = new Date();
      
        const diffSeconds = (now - lastRequest) / 1000;
      
        if (diffSeconds < 60) {
          return res.status(429).json({
            error: "Please wait before generating another report"
          });
        }
      }

      const parsedBody = sendUserDataSchema.safeParse(req.body);

if (!parsedBody.success) {
  return res.status(400).json({
    error: "Invalid request data",
    details: parsedBody.error.flatten()
  });
}
      
const {
  currentJob,
  yearsExperience,
  currentSalary,
  wishJob,
  cv,
  qualifications
} = parsedBody.data;

      const safeCV =
  cv?.length > 2000
    ? cv.slice(0, 2000) + "...(trimmed)"
    : cv;



    const limit = (text, max = 500) =>
      String(text || "").slice(0, max);
    
    const currentJobSafe = limit(currentJob, 120);
    const yearsExperienceSafe = limit(yearsExperience, 60);
    const wishJobSafe = limit(wishJob, 120);
    const qualificationsSafe = limit(qualifications, 1200);


    const parsedSalary = Number(
      String(currentSalary).replace(/[^\d]/g, "")
    );
    
    if (!parsedSalary || parsedSalary > 5000000) {
      return res.status(400).json({
        error: "Invalid salary"
      });
    }




    const [existingReports] = await pool.query(
      `
      SELECT *
      FROM income_reports
      WHERE user_id = ?
      AND current_job = ?
      AND current_salary = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [
        userId,
        currentJobSafe,
        parsedSalary
      ]
    );
    
    if (existingReports.length > 0) {
    
      const existing = existingReports[0];
    
      let cachedReport;
    
      try {
    
        cachedReport =
          typeof existing.ai_report === "string"
            ? JSON.parse(existing.ai_report)
            : existing.ai_report;
    
      } catch (e) {
    
        console.log("Cached report parse failed");
    
        cachedReport = null;
      }
    
      // ONLY return preview
      // Never expose full report before payment
    
      if (cachedReport) {
    
        const preview = {
          income_analysis: cachedReport.income_analysis,
          best_next_role: cachedReport.best_next_role,
          final_summary: cachedReport.final_summary
        };
    
        return res.json({
          preview,
          reportId: existing.id,
          cached: true
        });
    
      }
    }






  
      const prompt = `
  You are an elite career strategist working for a premium income optimization platform called RiseVexa.
  
  Your job is NOT to give generic advice.
  Your job is to identify income gaps and design a direct path to a higher-paying role.
  
  Be decisive, specific, and strategic. No fluff.
  
  -------------------------
  USER DATA
  -------------------------
  Current Role: ${currentJobSafe}
  Years Experience: ${yearsExperienceSafe}
  Current Salary: €${parsedSalary}
  Desired Role: ${wishJobSafe || "Not specified"}
  CV / Experience: """ ${safeCV} """
  Qualifications: """ ${qualificationsSafe || "Not provided"} """
  
  -------------------------
  TASK
  -------------------------
  Analyze the user and generate a HIGH-VALUE income upgrade report.
  
  Use realistic EU/UK market assumptions.
  
  -------------------------
  OUTPUT FORMAT (STRICT JSON)
  -------------------------
  {
    "income_analysis": {
      "role_level": "",
      "is_underpaid": true,
      "current_market_range": "€X - €Y",
      "estimated_fair_salary": "€X",
      "income_gap": "€X per year"
    },
    "best_next_role": {
      "target_role": "",
      "reasoning": "",
      "salary_range": "€X - €Y",
      "expected_salary_jump": "€X"
    },
    "90_day_transition_plan": [
      "Week 1-2: ...",
      "Week 3-4: ...",
      "Week 5-8: ...",
      "Week 9-12: ..."
    ],
    "cv_upgrade": {
      "problems": [
        "..."
      ],
      "fixes": [
        "Rewrite bullet point X to: ...",
        "Add measurable achievements such as ..."
      ]
    },
    "skills_gap": [
      "Skill 1",
      "Skill 2"
    ],
    "salary_increase_strategy": {
      "can_negotiate_current_job": true,
      "what_to_say": "Exact sentence the user can say to manager",
      "strategy": "How to approach negotiation"
    },
    "application_strategy": [
      "Where to apply",
      "How to stand out",
      "What to emphasise"
    ],
    "transferable_skills_match": [
  {
    "current_skill": "Managing technicians",
    "maps_to": "Operations coordination",
    "market_value": "High"
  }
],
"job_titles_to_search": [
  "Technical Operations Coordinator",
  "Field Service Planner",
  "Maintenance Project Specialist"
],
"market_demand": {
  "score": 82,
  "explanation": "Your operational + technical background is currently in high demand in logistics and industrial services."
},
"biggest_income_leak": "Your experience is framed operationally instead of commercially, reducing perceived strategic value.",
"fastest_salary_path": {
  "method": "Internal promotion",
  "timeline": "3-6 months",
  "difficulty": "Medium"
},
    "final_summary": {
      "current_path": "Where they are heading if they do nothing",
      "optimized_path": "Where they could realistically be in 3-6 months",
      "income_projection": "€X → €Y"
    }
  }
  
  ONLY return valid JSON. No explanations outside JSON.


  IMPORTANT:
Avoid generic corporate language.

DO NOT use phrases like:
- "results-driven professional"
- "operational excellence"
- "dynamic individual"
- "leveraging experience"

Every recommendation must:
- reference the user's actual background
- explain WHY they qualify
- provide realistic transitions
- sound like a real recruiter wrote it
- avoid motivational fluff

Salary estimates must remain realistic for EU/UK markets.
Avoid exaggerated compensation claims.
Prefer believable salary growth over dramatic claims.

Before generating output:
- identify top 3 transferable strengths
- identify 1 income bottleneck
- identify 1 realistic job transition path
- validate salary realism based on EU market

HARD CONSTRAINTS:

- Always return ALL fields in schema
- Never omit keys
- Always use EUR (€) format
- income_gap must be numeric string like "€12,000"
- salary_range must include low and high values
- reasoning must reference user's CV explicitly
- no motivational language
- no generic phrases
- no buzzwords
  `;
  
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a high-end career consultant." },
          { role: "user", content: prompt }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.2,
        max_tokens: 1800
      });
  
      const parsed = response.choices[0].message.content;


      let verifiedParsed;

      try {
        verifiedParsed = reportSchema.parse(
          typeof parsed === "string"
            ? JSON.parse(parsed)
            : parsed
        );
      } catch (err) {
        console.log("Schema validation failed:", err);
      
        return res.status(500).json({
          error: "Invalid AI report structure"
        });
      }



const usage = response.usage;

const promptTokens = usage.prompt_tokens || 0;
const completionTokens = usage.completion_tokens || 0;
const totalTokens = usage.total_tokens || 0;

// GPT-4o-mini pricing example
const inputCostPer1k = 0.00015;
const outputCostPer1k = 0.0006;

const estimatedCost =
  (promptTokens / 1000) * inputCostPer1k +
  (completionTokens / 1000) * outputCostPer1k;

await pool.query(
  `
  INSERT INTO ai_usage_analytics (
    user_id,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    estimated_cost,
    request_type
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  [
    userId,
    "gpt-4o-mini",
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost,
    "income_report"
  ]
);


const safe = (v) => v ?? "N/A";
const safeObj = (obj) => obj || {};

      const [insertResult] = await pool.query(
        `
        INSERT INTO income_reports (
          current_job,
          years_experience,
          current_salary,
          desired_role,
          cv_text,
          qualifications,
          ai_report,
          income_gap,
          target_role,
          projected_salary,
          user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          currentJobSafe,
          yearsExperienceSafe,
          parsedSalary,
          wishJobSafe,
          safeCV,
          qualificationsSafe,
      
          JSON.stringify(verifiedParsed),
      
          safeObj(verifiedParsed.income_analysis).income_gap,
safeObj(verifiedParsed.best_next_role).target_role,
safe(verifiedParsed.final_summary?.income_projection),
          userId
        ]
      );
      const reportId = insertResult.insertId;

      const preview = {
        income_analysis: verifiedParsed.income_analysis,
        best_next_role: verifiedParsed.best_next_role,
        final_summary: verifiedParsed.final_summary
      }
      
      res.json({
        preview,
        reportId 
      });
  
    } catch (e) {
      console.log("AI ERROR:", e);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.get("/reports", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const userId = req.user.id;
  
      const [reports] = await pool.query(
        `
        SELECT * FROM income_reports
        WHERE user_id = ? AND paid = ?
        ORDER BY created_at DESC
        `,
        [userId, true]
      );
      res.status(200).json({ reports: reports});
  
    } catch(e) {
  
      console.log(e);
  
      res.status(500).json({
        error: "Failed to fetch reports"
      });
  
    }
  });



  const supportRequestSchema = z.object({
    name: z
      .string()
      .min(2, "Name too short")
      .max(100, "Name too long"),
  
    email: z
      .string()
      .email("Invalid email")
      .max(255),
  
    issueType: z
      .string()
      .min(2)
      .max(100),
  
    issue: z
      .string()
      .min(10, "Issue too short")
      .max(5000, "Issue too long"),
  });
  
  const supportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 5, // max 5 requests per IP
    message: {
      msg: "Too many support requests. Please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return next();
    }
  
    return res.status(401).json({
      msg: "Unauthorized",
    });
  }
 
  app.post(
    "/send-support-request",
    ensureAuthenticated,
    supportLimiter,
    async (req, res) => {
      try {
        const parsed = supportRequestSchema.safeParse(req.body);
  
        if (!parsed.success) {
          return res.status(400).json({
            msg: "Invalid request data",
            errors: parsed.error.flatten(),
          });
        }
  
        const {
          name,
          email,
          issueType,
          issue,
        } = parsed.data;
  
        // NEVER trust userId from frontend
        // get it from authenticated session instead
        const userId = req.user.id;
  
        await pool.query(
          `
          INSERT INTO support_tickets 
          (user_id, name, email, issue_type, issue, status) 
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            userId,
            name.trim(),
            email.trim().toLowerCase(),
            issueType.trim(),
            issue.trim(),
            "in_progress",
          ]
        );
  
        return res.status(200).json({
          msg: "Support request submitted successfully",
        });
  
      } catch (e) {
        console.error(
          "Error in /send-support-request:",
          e
        );
  
        return res.status(500).json({
          msg: "Internal server error",
        });
      }
    }
  );



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});