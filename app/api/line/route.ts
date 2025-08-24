import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  getLists,
  createList,
  addItemsToList,
  getListWithItems,
  deleteList,
  deleteItemFromList,
} from "@/lib/db";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

// ユーザーの状態を管理（本来はRedisやDBに保存すべき）
const userStates = new Map<string, { waitingFor: string; listName?: string }>();

export async function POST(req: NextRequest) {
  const body = await req.text();

  // 署名検証
  const signature = req.headers.get("x-line-signature") || "";
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  if (signature !== `sha256=${hash}`) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const events = JSON.parse(body).events;

  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const replyToken = event.replyToken;
      const userMessage = event.message.text.trim();

      // ルーム識別：グループ > ルーム > ユーザーの順で優先
      const roomId =
        event.source.groupId || event.source.roomId || event.source.userId;

      let replyText = await processMessage(roomId, userMessage);

      // 空の返信の場合はスキップ
      if (!replyText) continue;

      // LINEに返信
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: replyToken,
          messages: [{ type: "text", text: replyText }],
        }),
      });
    }
  }

  return NextResponse.json({ message: "ok" });
}

async function processMessage(
  userId: string,
  message: string
): Promise<string> {
  // ユーザーが入力待ち状態かチェック
  const userState = userStates.get(userId);

  if (userState?.waitingFor === "items") {
    // アイテム追加の入力待ち状態
    const items = message.split("\n").filter((item) => item.trim());

    if (items.length === 0) {
      userStates.delete(userId);
      return "アイテムが入力されなかったよ。もう一度やり直してね！";
    }

    try {
      const list = await getListWithItems(userId, userState.listName!);
      if (list) {
        await addItemsToList(list.id, items);
        userStates.delete(userId);

        const itemList = items.map((item) => `・${item}`).join("\n");
        return `${userState.listName}に追加したよ！\n\n${itemList}`;
      } else {
        userStates.delete(userId);
        return "リストが見つからなかったよ。もう一度試してみて！";
      }
    } catch (error) {
      console.error("Database error:", error);
      userStates.delete(userId);
      return "エラーが発生したよ。もう一度試してみて！";
    }
  }

  // コマンド解析
  if (!message.startsWith("おぼえるくん")) {
    return ""; // おぼえるくん以外は無視
  }

  const parts = message.split(/\s+/);

  // 「おぼえるくん」のみの場合
  if (parts.length === 1) {
    return `やあ！おぼえるくんだよ！リスト管理が得意だよ✨

使い方：
・おぼえるくん [リスト名] 追加
・おぼえるくん [リスト名] 削除  
・おぼえるくん [リスト名] （中身を表示）
・おぼえるくん 一覧
・おぼえるくん bye（退出）

例：「おぼえるくん 買い物リスト 追加」`;
  }

  // 「おぼえるくん bye」の場合
  if (parts.length === 2 && parts[1] === "bye") {
    return "またね！おぼえるくんを呼んでくれてありがとう 👋";
  }

  // 「おぼえるくん 一覧」の場合
  if (parts.length === 2 && parts[1] === "一覧") {
    try {
      const lists = await getLists(userId);
      if (lists.length === 0) {
        return "まだリストがないよ！\n「おぼえるくん [リスト名] 追加」でリストを作ってみて！";
      }

      const listNames = lists.map((list) => `・${list.list_name}`).join("\n");
      return `今あるリストはこれだよ📝\n\n${listNames}`;
    } catch (error) {
      console.error("Database error:", error);
      return "エラーが発生したよ。もう一度試してみて！";
    }
  }

  // 「おぼえるくん [リスト名]」（リスト内容表示）の場合
  if (parts.length === 2) {
    const listName = parts[1];
    try {
      const list = await getListWithItems(userId, listName);
      if (!list || !list.items || list.items.length === 0) {
        return `${listName}はまだ空っぽだよ！\n「おぼえるくん ${listName} 追加」でアイテムを入れてみて！`;
      }

      const itemList = list.items
        .map((item) => `・${item.item_text}`)
        .join("\n");
      return `【${listName}】\n\n${itemList}`;
    } catch (error) {
      console.error("Database error:", error);
      return "エラーが発生したよ。もう一度試してみて！";
    }
  }

  // 「おぼえるくん [リスト名] [操作]」の場合
  if (parts.length >= 3) {
    const listName = parts[1];
    const action = parts[2];

    if (action === "追加") {
      try {
        await createList(userId, listName);
        userStates.set(userId, { waitingFor: "items", listName });
        return `${listName}に追加したい内容を教えてね！\n改行で区切って複数入力できるよ 📝`;
      } catch (error) {
        console.error("Database error:", error);
        return "エラーが発生したよ。もう一度試してみて！";
      }
    }

    if (action === "削除") {
      try {
        const deleted = await deleteList(userId, listName);
        if (deleted) {
          return `${listName}を削除したよ 🗑️`;
        } else {
          return `${listName}が見つからなかったよ。「おぼえるくん 一覧」で確認してみて！`;
        }
      } catch (error) {
        console.error("Database error:", error);
        return "エラーが発生したよ。もう一度試してみて！";
      }
    }
  }

  return "うーん、よくわからなかった！\n「おぼえるくん」だけ送ると使い方を教えるよ 😊";
}
