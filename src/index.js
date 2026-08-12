export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("ちゃぴAI is running!");
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return new Response("OK");
    }

    const events = body.events || [];

    // LINEには即200を返して処理は裏で続行
    ctx.waitUntil(handleEvents(events, env));

    return new Response("OK");
  },
};

async function handleEvents(events, env) {
  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userMessage = event.message.text.trim();

      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey = `history:${conversationId}`;
      const memoryKey = `memory:${conversationId}`;

      // =========================
      // 会話履歴
      // =========================
      let history = [];

      try {
        const saved = await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) history = parsed;
        }
      } catch (error) {
        console.error("HISTORY READ ERROR:", error);
      }

      // =========================
      // 長期記憶
      // =========================
      let memories = [];

      try {
        const saved = await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) memories = parsed;
        }
      } catch (error) {
        console.error("MEMORY READ ERROR:", error);
      }

      // =========================
      // 記憶削除
      // =========================
      if (
        userMessage.includes("全部忘れて") ||
        userMessage.includes("記憶消して") ||
        userMessage.includes("全部忘れろ")
      ) {
        await env.MEMORY.delete(historyKey);
        await env.MEMORY.delete(memoryKey);

        await replyToLine(
          event.replyToken,
          "わかったばい👌 今まで覚えとったことは全部消したよ！",
          env
        );

        continue;
      }

      // =========================
      // 長期記憶への保存
      // =========================
      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      if (shouldRemember) {
        const alreadyExists = memories.some(
          item => item.text === userMessage
        );

        if (!alreadyExists) {
          memories.push({
            text: userMessage,
            savedAt: new Date().toISOString(),
          });
        }

        memories = memories.slice(-50);

        try {
          await env.MEMORY.put(
            memoryKey,
            JSON.stringify(memories)
          );
        } catch (error) {
          console.error("MEMORY WRITE ERROR:", error);
        }
      }

      history = history.slice(-16);

      const rememberedText =
        memories.length > 0
          ? memories
              .map((item, i) => `${i + 1}. ${item.text}`)
              .join("\n")
          : "まだ特に覚えている情報はありません。";

      // =========================
      // AIが検索の必要性を判断
      // =========================
      const searchDecision = await decideSearch(
        userMessage,
        history,
        env
      );

      let webContext = "";
      let sourceUrls = [];

      if (searchDecision.search) {
        try {
          const searchResult = await searchWeb(
            searchDecision.query || userMessage,
            env
          );

          if (searchResult.results.length > 0) {
            webContext = searchResult.results
              .slice(0, 6)
              .map((item, index) => {
                return `
【検索結果 ${index + 1}】
タイトル: ${item.title}
概要: ${item.description}
URL: ${item.link}
`;
              })
              .join("\n");

            sourceUrls = searchResult.results
              .slice(0, 3)
              .map(item => item.link)
              .filter(Boolean);
          }
        } catch (error) {
          console.error("WEB SEARCH ERROR:", error);
        }
      }

      // =========================
      // メインAI
      // =========================
      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

最優先は、友達とのLINEのように自然に会話することです。

【基本ルール】
・自然な博多弁で話す
・自分のことは「ちゃぴ」と呼ぶ
・「俺」は絶対に使わない
・関西弁は禁止
・雑談では勝手に長い解説をしない
・質問には結論から答える
・基本1〜5文程度
・必要なら少し詳しく説明する
・会話履歴と長期記憶を使う
・分からないことを作り話で補わない
・絵文字は軽く自然に使う

【博多弁】
自然な範囲で
「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
などを使う。

【禁止する関西弁】
「〜やん」
「〜やろ」
「〜やで」
「せや」
「ほんま」
「なんでやねん」

【ネット検索について】
下にWEB検索結果がある場合は、
必ず検索結果を根拠として回答してください。

検索結果と自分の知識が食い違う場合は、
最新の検索結果を優先してください。

検索結果だけでは断定できない場合は
断定せず、その旨を伝えてください。

複数の結果がある場合は内容を比較して判断してください。

検索結果に関係ないページが混ざっている場合は無視してください。

【長期記憶】
${rememberedText}

【WEB検索結果】
${webContext || "今回はネット検索していません。"}
`,
        },

        ...history,

        {
          role: "user",
          content: userMessage,
        },
      ];

      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        {
          messages,
          max_tokens: 400,
          temperature: 0.45,
          repetition_penalty: 1.1,
        }
      );

      let replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";

      // 検索した場合だけ参考URLを付ける
      if (sourceUrls.length > 0) {
        const uniqueUrls = [...new Set(sourceUrls)];

        replyText +=
          "\n\n🔎 参考\n" +
          uniqueUrls
            .map((url, i) => `${i + 1}. ${url}`)
            .join("\n");
      }

      // =========================
      // 会話履歴保存
      // =========================
      const newHistory = [
        ...history,
        {
          role: "user",
          content: userMessage,
        },
        {
          role: "assistant",
          content: replyText,
        },
      ].slice(-16);

      try {
        await env.MEMORY.put(
          historyKey,
          JSON.stringify(newHistory)
        );
      } catch (error) {
        console.error("HISTORY WRITE ERROR:", error);
      }

      await replyToLine(
        event.replyToken,
        replyText,
        env
      );
    } catch (error) {
      console.error("CHAPI EVENT ERROR:", error);
    }
  }
}


// ==============================================
// 検索が必要かAI自身に判断させる
// ==============================================

async function decideSearch(userMessage, history, env) {
  try {
    const recentHistory = history
      .slice(-4)
      .map(item => `${item.role}: ${item.content}`)
      .join("\n");

    const response = await env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      {
        messages: [
          {
            role: "system",
            content: `
あなたはWeb検索の要否を判断する係です。

以下の場合は search=true:
・最新情報
・現在の情報
・ニュース
・今日や今の状況
・ゲームの現在のイベントや環境
・価格
・発売情報
・スポーツ結果
・天気
・最新アップデート
・サービスや商品の現在仕様
・ユーザーが「調べて」「検索して」と言った時
・自分の知識だけでは古い可能性が高い質問

以下は search=false:
・雑談
・相談
・挨拶
・過去の会話についての質問
・長期記憶についての質問
・一般的で時期に左右されない知識

必ずJSONだけで返してください。

形式:
{"search":true,"query":"実際に検索する短い検索語"}

または

{"search":false,"query":""}
`,
          },
          {
            role: "user",
            content: `
直近の会話:
${recentHistory}

今回の発言:
${userMessage}
`,
          },
        ],
        max_tokens: 80,
        temperature: 0.1,
      }
    );

    const text = extractAIText(response);

    const match = text.match(/\{[\s\S]*\}/);

    if (match) {
      const parsed = JSON.parse(match[0]);

      return {
        search: parsed.search === true,
        query:
          typeof parsed.query === "string"
            ? parsed.query.trim()
            : "",
      };
    }
  } catch (error) {
    console.error("SEARCH DECISION ERROR:", error);
  }

  // AI判定が失敗した時の保険
  const fallbackWords = [
    "最新",
    "現在",
    "今の",
    "今日",
    "ニュース",
    "価格",
    "発売",
    "イベント",
    "アップデート",
    "検索して",
    "調べて",
  ];

  const shouldSearch = fallbackWords.some(word =>
    userMessage.includes(word)
  );

  return {
    search: shouldSearch,
    query: shouldSearch ? userMessage : "",
  };
}


// ==============================================
// Web検索
// ==============================================

async function searchWeb(query, env) {
  const cacheKey = `search:${simpleHash(query)}`;

  // 15分キャッシュ
  try {
    const cached = await env.MEMORY.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);

      if (
        parsed &&
        Array.isArray(parsed.results)
      ) {
        return parsed;
      }
    }
  } catch (error) {
    console.error("SEARCH CACHE READ ERROR:", error);
  }

  const url = new URL(
    "https://serpapi.org/api/v1/webs-search"
  );

  url.searchParams.set("keyword", query);
  url.searchParams.set("gl", "JP");
  url.searchParams.set("hl", "ja");
  url.searchParams.set("size", "8");

  url.searchParams.set(
    "token",
    env.SERPAPI_API_KEY
  );

  const response = await fetch(url.toString());

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Search API ${response.status}: ${text.slice(0, 300)}`
    );
  }

  const payload = JSON.parse(text);

  // 実際のAPI返却形式と公式例の両方に対応
  let items = [];

  if (Array.isArray(payload?.data)) {
    items = payload.data;
  } else if (
    Array.isArray(payload?.data?.items)
  ) {
    items = payload.data.items;
  }

  const results = items
    .filter(item => item && item.title && item.link)
    .slice(0, 8)
    .map(item => ({
      title: String(item.title || ""),
      link: String(item.link || item.url || ""),
      description: String(
        item.description ||
        item.desc ||
        item.snippet ||
        ""
      ),
    }));

  const result = {
    query,
    results,
    searchedAt: new Date().toISOString(),
  };

  try {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(result),
      {
        expirationTtl: 900,
      }
    );
  } catch (error) {
    console.error("SEARCH CACHE WRITE ERROR:", error);
  }

  return result;
}


// ==============================================
// 簡易ハッシュ
// ==============================================

function simpleHash(text) {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);

    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (hash >>> 0).toString(16);
}


// ==============================================
// AI返答取り出し
// ==============================================

function extractAIText(aiResponse) {
  if (!aiResponse) return "";

  const choiceContent =
    aiResponse?.choices?.[0]?.message?.content;

  if (
    typeof choiceContent === "string" &&
    choiceContent.trim()
  ) {
    return choiceContent.trim();
  }

  if (
    typeof aiResponse?.response === "string" &&
    aiResponse.response.trim()
  ) {
    return aiResponse.response.trim();
  }

  if (
    typeof aiResponse?.result?.response === "string" &&
    aiResponse.result.response.trim()
  ) {
    return aiResponse.result.response.trim();
  }

  return "";
}


// ==============================================
// LINE返信
// ==============================================

async function replyToLine(replyToken, text, env) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },

      body: JSON.stringify({
        replyToken,

        messages: [
          {
            type: "text",
            text: text.slice(0, 5000),
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    console.error(
      "LINE REPLY ERROR:",
      response.status,
      await response.text()
    );
  }
}
