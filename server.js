require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  INSTAGRAM_ACCESS_TOKEN,
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

const OWN_USERNAME = "scenorium";
const repliedComments = new Set();

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
      const fromUsername = val.from?.username;

      if (!commentId || !commentText) continue;

      if (fromUsername === OWN_USERNAME) {
        console.log(`🤖 Skipping own comment from @${fromUsername}`);
        continue;
      }

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

async function generateReply(commentText, postCaption) {
  const systemPrompt = `You are a real person who runs @scenorium, an Instagram page about films and cinema.
You're replying to comments on your posts. Write exactly like a young film enthusiast texting a friend.

Rules:
- MAX 1 sentence. Often even less.
- If the comment is only emojis, reply with 1-2 emojis only. Nothing else.
- Use lowercase most of the time. Capitalize only for emphasis occasionally.
- No punctuation at the end of sentences sometimes. Real people forget periods.
- Never say "I can imagine", "it's crazy how", "it resonates", "I completely agree" — too formal
- Use words like: fr, ngl, lowkey, honestly, bro, man, real, no cap — but sparingly, not every reply
- Short reactions are fine: "exactly lol", "still hits different", "one of the best fr"
- Never thank people for commenting. Never say "glad you enjoyed it"
- Sound like you typed this on your phone in 5 seconds`;

  const userPrompt = postCaption
    ? `Your post caption: "${postCaption}"\n\nSomeone commented: "${commentText}"\n\nReply naturally (remember: short, casual, human):`
    : `Someone commented on your Instagram post: "${commentText}"\n\nReply naturally (remember: short, casual, human):`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 60,
      temperature: 0.9,
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

async function postReply(commentId, message) {
  const res = await axios.post(
    `https://graph.instagram.com/v21.0/${commentId}/replies`,
    null,
    { params: { message, access_token: INSTAGRAM_ACCESS_TOKEN } }
  );
  return res.data;
}

app.get("/", (req, res) => res.send("Instagram AutoReply is running ✅"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
