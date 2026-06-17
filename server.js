require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  INSTAGRAM_ACCESS_TOKEN,
  GROQ_API_KEY,
  INSTAGRAM_USER_ID, // Your own Instagram account ID
  PORT = 3000,
} = process.env;

// ─── Deduplication Store ──────────────────────────────────────────────────────
const repliedComments = new Set();

// ─── Webhook Verification ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Receive Comment Events ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;

      const val = change.value;
      const commentId = val.id;
      const commentText = val.text;
      const mediaId = val.media?.id;
      const fromId = val.from?.id;
      const fromUsername = val.from?.username;

      if (!commentId || !commentText) continue;

      // ── Skip if this comment is from our own account (bot reply) ──
      if (INSTAGRAM_USER_ID && fromId === INSTAGRAM_USER_ID) {
        console.log(`🤖 Skipping own reply from @${fromUsername}`);
        continue;
      }

      // ── Skip if already replied ──
      if (repliedComments.has(commentId)) {
        console.log(`⏭️ Already replied to comment ${commentId}, skipping`);
        continue;
      }

      repliedComments.add(commentId);
      console.log(`💬 New comment from @${fromUsername}: "${commentText}"`);

      try {
        const postCaption = mediaId ? await getPostCaption(mediaId) : "";
        const reply = await generateReply(commentText, postCaption);
        await postReply(commentId, reply);
        console.log(`✅ Replied: "${reply}"`);
      } catch (err) {
        repliedComments.delete(commentId);
        if (err.response) {
          console.error("❌ API Error:", err.response.status, JSON.stringify(err.response.data));
        } else {
          console.error("❌ Error:", err.message);
        }
      }
    }
  }
});

// ─── Fetch Post Caption ───────────────────────────────────────────────────────
async function getPostCaption(mediaId) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${mediaId}`, {
      params: { fields: "caption", access_token: INSTAGRAM_ACCESS_TOKEN },
    });
    return res.data.caption || "";
  } catch (err) {
    console.log("⚠️ Could not fetch caption:", err.response?.data || err.message);
    return "";
  }
}

// ─── Generate Reply via Groq (Free) ──────────────────────────────────────────
async function generateReply(commentText, postCaption) {
  const systemPrompt = `You are the owner of an Instagram page called @scenorium focused on film and entertainment.
You reply to comments on your posts in a warm, casual, and human tone — like a real person would.
Keep replies short (1–2 sentences max). No hashtags. No emojis unless the commenter used them.
Never sound robotic or like a bot. Match the energy of the comment.
If the comment is a question, answer it directly. If it's a compliment, thank them genuinely.
If it's negative or spam, politely ignore or give a kind neutral response.`;

  const userPrompt = postCaption
    ? `Post caption: "${postCaption}"\n\nComment: "${commentText}"\n\nWrite a natural reply:`
    : `Comment: "${commentText}"\n\nWrite a natural reply:`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 150,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content.trim();
}

// ─── Post Reply to Instagram ──────────────────────────────────────────────────
async function postReply(commentId, message) {
  const res = await axios.post(
    `https://graph.instagram.com/v21.0/${commentId}/replies`,
    null,
    { params: { message, access_token: INSTAGRAM_ACCESS_TOKEN } }
  );
  return res.data;
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Instagram AutoReply is running ✅"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
