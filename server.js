require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  INSTAGRAM_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

// ─── Webhook Verification (Facebook handshake) ────────────────────────────────
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
  res.sendStatus(200); // Always respond fast to Facebook

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;

      const { id: commentId, text: commentText, media } = change.value;
      const mediaId = media?.id;

      if (!commentId || !commentText || !mediaId) continue;

      console.log(`💬 New comment on media ${mediaId}: "${commentText}"`);

      try {
        const postCaption = await getPostCaption(mediaId);
        const reply = await generateReply(commentText, postCaption);
        await postReply(commentId, reply);
        console.log(`✅ Replied: "${reply}"`);
      } catch (err) {
        console.error("❌ Error handling comment:", err.message);
      }
    }
  }
});

// ─── Fetch Post Caption ───────────────────────────────────────────────────────
async function getPostCaption(mediaId) {
  try {
    const res = await axios.get(`https://graph.instagram.com/${mediaId}`, {
      params: { fields: "caption", access_token: INSTAGRAM_ACCESS_TOKEN },
    });
    return res.data.caption || "";
  } catch {
    return "";
  }
}

// ─── Generate Reply via Claude ────────────────────────────────────────────────
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
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.content[0].text.trim();
}

// ─── Post Reply to Instagram ──────────────────────────────────────────────────
async function postReply(commentId, message) {
  await axios.post(`https://graph.instagram.com/${commentId}/replies`, {
    message,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Instagram AutoReply is running ✅"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
