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

// ルーム（グループ/個人チャット）の状態を管理（本来はRedisやDBに保存すべき）
const roomStates = new Map<string, { waitingFor: string; listName?: string }>();

export async function POST(req: NextRequest) {
  const body = await req.text();
  console.log("Received webhook:", JSON.stringify(JSON.parse(body), null, 2));

  // 署名検証
  const signature = req.headers.get("x-line-signature") || "";
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  console.log("Signature verification:", { signature, hash });

  if (signature !== hash) {
    console.log("Signature verification failed");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const events = JSON.parse(body).events;

  for (const event of events) {
    console.log("Processing event:", event);

    if (event.type === "message" && event.message.type === "text") {
      const replyToken = event.replyToken;
      const userMessage = event.message.text.trim();

      // ルーム識別：グループ > ルーム > ユーザーの順で優先
      const roomId =
        event.source.groupId || event.source.roomId || event.source.userId;

      console.log("Room ID:", roomId, "Message:", userMessage);

      let replyText = await processMessage(roomId, userMessage);

      console.log("Reply text:", replyText);

      // 空の返信の場合はスキップ
      if (!replyText) {
        console.log("Empty reply, skipping");
        continue;
      }

      // LINEに返信
      const response = await fetch("https://api.line.me/v2/bot/message/reply", {
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

      console.log("LINE API response:", response.status, await response.text());
    }
  }

  return NextResponse.json({ message: "ok" });
}

async function processMessage(
  roomId: string,
  message: string
): Promise<string> {
  // ルームが入力待ち状態かチェック
  const roomState = roomStates.get(roomId);

  if (roomState?.waitingFor === "items") {
    // アイテム追加の入力待ち状態
    const items = message.split("\n").filter((item) => item.trim());

    if (items.length === 0) {
      roomStates.delete(roomId);
      return "おや？アイテムが入力されなかったみたい🤔\nもう一度「おぼえるくん [リスト名] 追加」でやり直してね！";
    }

    try {
      const list = await getListWithItems(roomId, roomState.listName!);
      if (list) {
        const addedItems = await addItemsToList(list.id, items);
        roomStates.delete(roomId);

        const itemList = addedItems
          .map((item) => `・${item.item_text}`)
          .join("\n");
        return `やったね！${roomState.listName}に追加完了だよ✨\n\n【追加されたアイテム】\n${itemList}\n\n「おぼえるくん ${roomState.listName}」で全部の中身も確認できるよ！`;
      } else {
        roomStates.delete(roomId);
        return "あれ？リストが見つからなかった😅\nもう一度試してみてね！";
      }
    } catch (error) {
      console.error("Database error:", error);
      roomStates.delete(roomId);
      return "ごめん！何かエラーが起きちゃった😵\nもう一度試してみてくれる？";
    }
  }

  // コマンド解析
  if (!message.startsWith("おぼえるくん")) {
    return ""; // おぼえるくん以外は無視
  }

  const parts = message.split(/\s+/);

  // 「おぼえるくん」のみの場合
  if (parts.length === 1) {
    return `やっほー！おぼえるくんだよ〜🤖
リスト管理のお手伝いをするから任せて！✨

【基本の使い方】
• おぼえるくん [リスト名] 追加 → アイテムを追加
• おぼえるくん [リスト名] → リストの中身を表示  
• おぼえるくん [リスト名] 削除 → リスト全体を削除
• おぼえるくん [リスト名] [アイテム名] 削除 → 1つのアイテムを削除
• おぼえるくん 一覧 → 全リスト一覧
• おぼえるくん bye → 退室（寂しいけど...😢）

【例】「おぼえるくん 買い物リスト 追加」
→ 何を追加するか聞くから改行で区切って送ってね！

困ったときはいつでも「おぼえるくん」って呼んでね😊`;
  }

  // 「おぼえるくん bye」の場合
  if (parts.length === 2 && parts[1] === "bye") {
    return "さようなら〜👋 また呼んでくれたら嬉しいな！\nおぼえるくんはいつでも君のリスト管理を待ってるよ✨";
  }

  // 「おぼえるくん 一覧」の場合
  if (parts.length === 2 && parts[1] === "一覧") {
    try {
      const lists = await getLists(roomId);
      if (lists.length === 0) {
        return "まだリストがないみたい📝\n「おぼえるくん [リスト名] 追加」でリストを作ってみよう！\n\n例：おぼえるくん 買い物リスト 追加";
      }

      const listNames = lists.map((list) => `・${list.list_name}`).join("\n");
      return `現在のリスト一覧だよ〜📋\n\n${listNames}\n\n各リストの中身を見たいときは「おぼえるくん [リスト名]」って送ってね！`;
    } catch (error) {
      console.error("Database error:", error);
      return "あら？リスト一覧の取得でエラーが発生しちゃった😅\nもう一度試してみて！";
    }
  }

  // 「おぼえるくん [リスト名]」（リスト内容表示）の場合
  if (parts.length === 2) {
    const listName = parts[1];
    try {
      const list = await getListWithItems(roomId, listName);
      if (!list || !list.items || list.items.length === 0) {
        return `「${listName}」はまだ空っぽだよ〜📝\n「おぼえるくん ${listName} 追加」でアイテムを入れてみよう！`;
      }

      const itemList = list.items
        .map((item) => `・${item.item_text}`)
        .join("\n");
      return `【${listName}】の中身だよ✨\n\n${itemList}\n\n何か追加するなら「おぼえるくん ${listName} 追加」\n特定のアイテムを消すなら「おぼえるくん ${listName} [アイテム名] 削除」だよ！`;
    } catch (error) {
      console.error("Database error:", error);
      return "リストの取得でエラーが発生しちゃった😅\nもう一度試してみて！";
    }
  }

  // 「おぼえるくん [リスト名] [操作]」または「おぼえるくん [リスト名] [アイテム名] 削除」の場合
  if (parts.length >= 3) {
    const listName = parts[1];

    // 4つ以上の場合は「アイテム削除」の可能性をチェック
    if (parts.length >= 4 && parts[parts.length - 1] === "削除") {
      // 「おぼえるくん [リスト名] [アイテム名...] 削除」
      const itemName = parts.slice(2, -1).join(" "); // 最後の「削除」を除いてアイテム名を結合

      try {
        const deleted = await deleteItemFromList(roomId, listName, itemName);
        if (deleted) {
          const updatedList = await getListWithItems(roomId, listName);
          if (
            updatedList &&
            updatedList.items &&
            updatedList.items.length > 0
          ) {
            const itemList = updatedList.items
              .map((item) => `・${item.item_text}`)
              .join("\n");
            return `よし！「${itemName}」を削除したよ🗑️\n\n【${listName}】の最新の中身：\n${itemList}`;
          } else {
            return `「${itemName}」を削除したら、${listName}が空になっちゃった😅\n新しいアイテムを追加するなら「おぼえるくん ${listName} 追加」だよ！`;
          }
        } else {
          return `あれ？「${itemName}」が${listName}に見つからなかった🤔\n「おぼえるくん ${listName}」で中身を確認してみて！`;
        }
      } catch (error) {
        console.error("Database error:", error);
        return "アイテム削除でエラーが発生しちゃった😅\nもう一度試してみて！";
      }
    }

    // 通常の操作（3つの場合）
    if (parts.length === 3) {
      const action = parts[2];

      if (action === "追加") {
        try {
          await createList(roomId, listName);
          roomStates.set(roomId, { waitingFor: "items", listName });
          return `${listName}に追加したいものを教えてね〜📝\n改行で区切って複数のアイテムを一度に追加できるよ！\n\n例：\nネギ\nキャベツ\nひき肉`;
        } catch (error) {
          console.error("Database error:", error);
          return "リスト作成でエラーが発生しちゃった😅\nもう一度試してみて！";
        }
      }

      if (action === "削除") {
        try {
          const deleted = await deleteList(roomId, listName);
          if (deleted) {
            return `「${listName}」を完全に削除したよ🗑️\nまた新しいリストが必要になったらいつでも作ってね！`;
          } else {
            return `あれ？「${listName}」が見つからなかった🤔\n「おぼえるくん 一覧」で確認してみて！`;
          }
        } catch (error) {
          console.error("Database error:", error);
          return "リスト削除でエラーが発生しちゃった😅\nもう一度試してみて！";
        }
      }
    }
  }

  return "うーん、ちょっとよくわからなかった😅\n「おぼえるくん」だけ送ると使い方を詳しく教えるよ〜📚";
}
