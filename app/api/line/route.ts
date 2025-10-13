import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  getLists,
  createList,
  addItemsToList,
  getListWithItems,
  deleteList,
  deleteItemFromList,
  getReminders,
  createReminder,
  deleteReminder,
  getReminderByName,
  updateReminder,
  getCompletedReminders,
  snoozeReminder,
  completeReminder,
} from "@/lib/db";
import {
  parseDateTime,
  formatDateTime,
  getRelativeTime,
  parseRepeatPattern,
} from "@/lib/dateParser";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

// ルーム（グループ/個人チャット）の状態を管理
const roomStates = new Map<
  string,
  { waitingFor: string; listName?: string; reminderName?: string }
>();

export async function POST(req: NextRequest) {
  const body = await req.text();

  // 署名検証
  const signature = req.headers.get("x-line-signature") || "";
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  if (signature !== hash) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const events = JSON.parse(body).events;

  for (const event of events) {
    // テキストメッセージ処理
    if (event.type === "message" && event.message.type === "text") {
      const replyToken = event.replyToken;
      const userMessage = event.message.text.trim();

      const roomId =
        event.source.groupId || event.source.roomId || event.source.userId;

      let replyMessages = await processMessage(roomId, userMessage);

      if (!replyMessages || replyMessages.length === 0) continue;

      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: replyToken,
          messages: replyMessages,
        }),
      });
    }

    // Postbackイベント処理（スヌーズボタン）
    if (event.type === "postback") {
      const replyToken = event.replyToken;
      const data = new URLSearchParams(event.postback.data);
      const action = data.get("action");
      const reminderId = parseInt(data.get("reminder_id") || "0");

      let replyText = "";

      if (action === "snooze") {
        const minutes = parseInt(data.get("minutes") || "10");
        try {
          await snoozeReminder(reminderId, minutes);
          replyText = `⏰ ${minutes}分後にまたリマインドするね！`;
        } catch (error) {
          console.error("Snooze error:", error);
          replyText = "スヌーズの設定でエラーが発生しちゃった😅";
        }
      } else if (action === "complete") {
        try {
          await completeReminder(reminderId);
          replyText = "✅ リマインダーを完了にしたよ！お疲れさま 🎉";
        } catch (error) {
          console.error("Complete error:", error);
          replyText = "完了処理でエラーが発生しちゃった😅";
        }
      }

      if (replyText) {
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
  }

  return NextResponse.json({ message: "ok" });
}

async function processMessage(roomId: string, message: string): Promise<any[]> {
  // ルームが入力待ち状態かチェック
  const roomState = roomStates.get(roomId);

  // リスト追加の入力待ち
  if (roomState?.waitingFor === "items") {
    const items = message.split("\n").filter((item) => item.trim());

    if (items.length === 0) {
      roomStates.delete(roomId);
      return [
        {
          type: "text",
          text: "おや？アイテムが入力されなかったみたい🤔\nもう一度「おぼえるくん [リスト名] 追加」でやり直してね！",
        },
      ];
    }

    try {
      const list = await getListWithItems(roomId, roomState.listName!);
      if (list) {
        const addedItems = await addItemsToList(list.id, items);
        roomStates.delete(roomId);

        const itemList = addedItems
          .map((item) => `・${item.item_text}`)
          .join("\n");
        return [
          {
            type: "text",
            text: `やったね！**【${roomState.listName}】**に追加完了だよ✨\n\n**追加されたアイテム**\n${itemList}\n\n「おぼえるくん ${roomState.listName}」で全部の中身も確認できるよ！`,
          },
        ];
      } else {
        roomStates.delete(roomId);
        return [
          {
            type: "text",
            text: "あれ？リストが見つからなかった😅\nもう一度試してみてね！",
          },
        ];
      }
    } catch (error) {
      console.error("Database error:", error);
      roomStates.delete(roomId);
      return [
        {
          type: "text",
          text: "ごめん！何かエラーが起きちゃった😵\nもう一度試してみてくれる？",
        },
      ];
    }
  }

  // おぼえるくん（リスト管理）
  if (message.startsWith("おぼえるくん")) {
    return await processListCommand(roomId, message);
  }

  // おしえてくん（リマインダー）
  if (message.startsWith("おしえてくん")) {
    return await processReminderCommand(roomId, message);
  }

  // 使い方・ヘルプ
  if (message === "使い方" || message === "ヘルプ" || message === "help") {
    return await showHelp();
  }

  return []; // 該当なしは無視
}

// リスト管理コマンド処理
async function processListCommand(
  roomId: string,
  message: string
): Promise<any[]> {
  const parts = message.split(/\s+/);

  // 「おぼえるくん」のみ
  if (parts.length === 1) {
    return await showHelp();
  }

  // 「おぼえるくん bye」
  if (parts.length === 2 && parts[1] === "bye") {
    return [
      {
        type: "text",
        text: "さようなら〜👋 また呼んでくれたら嬉しいな！\nおぼえるくんはいつでも君のリスト管理を待ってるよ✨",
      },
    ];
  }

  // 「おぼえるくん 一覧」
  if (parts.length === 2 && parts[1] === "一覧") {
    try {
      const lists = await getLists(roomId);
      if (lists.length === 0) {
        return [
          {
            type: "text",
            text: "まだリストがないみたい📝\n「おぼえるくん [リスト名] 追加」でリストを作ってみよう！\n\n例：おぼえるくん 買い物リスト 追加",
          },
        ];
      }

      const listNames = lists.map((list) => `・${list.list_name}`).join("\n");
      return [
        {
          type: "text",
          text: `**現在のリスト一覧** 📋\n\n${listNames}\n\n各リストの中身を見たいときは「おぼえるくん [リスト名]」って送ってね！`,
        },
      ];
    } catch (error) {
      console.error("Database error:", error);
      return [
        {
          type: "text",
          text: "あら？リスト一覧の取得でエラーが発生しちゃった😅\nもう一度試してみて！",
        },
      ];
    }
  }

  // 「おぼえるくん [リスト名]」
  if (parts.length === 2) {
    const listName = parts[1];
    try {
      const list = await getListWithItems(roomId, listName);
      if (!list || !list.items || list.items.length === 0) {
        return [
          {
            type: "text",
            text: `「${listName}」はまだ空っぽだよ〜📝\n「おぼえるくん ${listName} 追加」でアイテムを入れてみよう！`,
          },
        ];
      }

      const itemList = list.items
        .map((item) => `・${item.item_text}`)
        .join("\n");
      return [
        {
          type: "text",
          text: `**【${listName}】の中身** ✨\n\n${itemList}\n\n何か追加するなら「おぼえるくん ${listName} 追加」\n特定のアイテムを消すなら「おぼえるくん ${listName} [アイテム名] 削除」だよ！`,
        },
      ];
    } catch (error) {
      console.error("Database error:", error);
      return [
        {
          type: "text",
          text: "リストの取得でエラーが発生しちゃった😅\nもう一度試してみて！",
        },
      ];
    }
  }

  // アイテム削除：「おぼえるくん [リスト名] [アイテム名] 削除」
  if (parts.length >= 4 && parts[parts.length - 1] === "削除") {
    const listName = parts[1];
    const itemName = parts.slice(2, -1).join(" ");

    try {
      const deleted = await deleteItemFromList(roomId, listName, itemName);
      if (deleted) {
        const updatedList = await getListWithItems(roomId, listName);
        if (updatedList && updatedList.items && updatedList.items.length > 0) {
          const itemList = updatedList.items
            .map((item) => `・${item.item_text}`)
            .join("\n");
          return [
            {
              type: "text",
              text: `よし！「${itemName}」を削除したよ🗑️\n\n**【${listName}】の最新の中身**\n${itemList}`,
            },
          ];
        } else {
          return [
            {
              type: "text",
              text: `「${itemName}」を削除したら、**【${listName}】**が空になっちゃった😅\n新しいアイテムを追加するなら「おぼえるくん ${listName} 追加」だよ！`,
            },
          ];
        }
      } else {
        return [
          {
            type: "text",
            text: `あれ？「${itemName}」が**【${listName}】**に見つからなかった🤔\n「おぼえるくん ${listName}」で中身を確認してみて！`,
          },
        ];
      }
    } catch (error) {
      console.error("Database error:", error);
      return [
        {
          type: "text",
          text: "アイテム削除でエラーが発生しちゃった😅\nもう一度試してみて！",
        },
      ];
    }
  }

  // 通常の操作（3つの場合）
  if (parts.length === 3) {
    const listName = parts[1];
    const action = parts[2];

    if (action === "追加") {
      try {
        await createList(roomId, listName);
        roomStates.set(roomId, { waitingFor: "items", listName });
        return [
          {
            type: "text",
            text: `**【${listName}】**に追加したいものを教えてね〜📝\n改行で区切って複数のアイテムを一度に追加できるよ！\n\n例：\nネギ\nキャベツ\nひき肉`,
          },
        ];
      } catch (error) {
        console.error("Database error:", error);
        return [
          {
            type: "text",
            text: "リスト作成でエラーが発生しちゃった😅\nもう一度試してみて！",
          },
        ];
      }
    }

    if (action === "削除") {
      try {
        const deleted = await deleteList(roomId, listName);
        if (deleted) {
          return [
            {
              type: "text",
              text: `「${listName}」を完全に削除したよ🗑️\nまた新しいリストが必要になったらいつでも作ってね！`,
            },
          ];
        } else {
          return [
            {
              type: "text",
              text: `あれ？「${listName}」が見つからなかった🤔\n「おぼえるくん 一覧」で確認してみて！`,
            },
          ];
        }
      } catch (error) {
        console.error("Database error:", error);
        return [
          {
            type: "text",
            text: "リスト削除でエラーが発生しちゃった😅\nもう一度試してみて！",
          },
        ];
      }
    }
  }

  return [
    {
      type: "text",
      text: "うーん、ちょっとよくわからなかった😅\n「おぼえるくん」だけ送ると使い方を詳しく教えるよ〜📚",
    },
  ];
}

// リマインダーコマンド処理
async function processReminderCommand(
  roomId: string,
  message: string
): Promise<any[]> {
  const parts = message.split(/\s+/);

  // 「おしえてくん」のみ
  if (parts.length === 1) {
    return await showHelp();
  }

  // 「おしえてくん 一覧」
  if (parts.length === 2 && parts[1] === "一覧") {
    try {
      const reminders = await getReminders(roomId);
      if (reminders.length === 0) {
        return [
          {
            type: "text",
            text: "まだリマインダーがないみたい⏰\n「おしえてくん 明日 9時 ゴミ出し」みたいに登録してみよう！",
          },
        ];
      }

      let text = "**登録中のリマインダー** ⏰\n\n";
      for (const reminder of reminders) {
        const priority =
          reminder.priority === "high"
            ? "🔴"
            : reminder.priority === "low"
            ? "🟢"
            : "🟡";
        const repeat =
          reminder.repeat_pattern === "daily"
            ? "🔄毎日"
            : reminder.repeat_pattern === "weekly"
            ? "🔄毎週"
            : reminder.repeat_pattern === "monthly"
            ? "🔄毎月"
            : "";
        text += `${priority} **${reminder.reminder_name}**\n`;
        text += `   ${formatDateTime(
          new Date(reminder.remind_at)
        )} (${getRelativeTime(new Date(reminder.remind_at))}) ${repeat}\n\n`;
      }

      return [{ type: "text", text }];
    } catch (error) {
      console.error("Database error:", error);
      return [
        {
          type: "text",
          text: "リマインダー一覧の取得でエラーが発生しちゃった😅\nもう一度試してみて！",
        },
      ];
    }
  }

  // 「おしえてくん 履歴」
  if (parts.length === 2 && parts[1] === "履歴") {
    try {
      const completed = await getCompletedReminders(roomId, 10);
      if (completed.length === 0) {
        return [
          { type: "text", text: "まだ完了したリマインダーがないみたい📜" },
        ];
      }

      let text = "**完了したリマインダー履歴** 📜\n\n";
      for (const reminder of completed) {
        text += `✅ ${reminder.reminder_name}\n`;
        text += `   完了: ${formatDateTime(new Date(reminder.updated_at))}\n\n`;
      }

      return [{ type: "text", text }];
    } catch (error) {
      console.error("Database error:", error);
      return [{ type: "text", text: "履歴の取得でエラーが発生しちゃった😅" }];
    }
  }

  // 「おしえてくん [リマインダー名] 削除」
  if (parts.length === 3 && parts[2] === "削除") {
    const reminderName = parts[1];
    try {
      const deleted = await deleteReminder(roomId, reminderName);
      if (deleted) {
        return [
          {
            type: "text",
            text: `「${reminderName}」のリマインダーを削除したよ🗑️`,
          },
        ];
      } else {
        return [
          {
            type: "text",
            text: `「${reminderName}」のリマインダーが見つからなかった🤔\n「おしえてくん 一覧」で確認してみて！`,
          },
        ];
      }
    } catch (error) {
      console.error("Database error:", error);
      return [{ type: "text", text: "削除でエラーが発生しちゃった😅" }];
    }
  }

  // リマインダー新規登録：「おしえてくん [日付] [時刻] [用件...]」
  if (parts.length >= 4) {
    const dateStr = parts[1];
    const timeStr = parts[2];
    const taskParts = parts.slice(3);

    // 繰り返しパターンを検出
    const fullMessage = taskParts.join(" ");
    const repeatPattern = parseRepeatPattern(fullMessage);
    const task = fullMessage
      .replace(/毎日|毎週|毎月|まいにち|まいしゅう|まいつき/g, "")
      .trim();

    const parsed = parseDateTime(dateStr, timeStr);

    if (!parsed.success) {
      return [
        {
          type: "text",
          text: parsed.error || "日時の設定でエラーが発生したよ😅",
        },
      ];
    }

    try {
      // リマインダー名は用件の最初の20文字程度
      const reminderName = task.substring(0, 20);

      await createReminder(
        roomId,
        reminderName,
        task,
        parsed.date,
        repeatPattern || undefined
      );

      let confirmText = `リマインダーを設定したよ！⏰\n\n`;
      confirmText += `**いつ**: ${formatDateTime(
        parsed.date
      )} (${getRelativeTime(parsed.date)})\n`;
      confirmText += `**用件**: ${task}\n`;
      if (repeatPattern) {
        const repeatText =
          repeatPattern === "daily"
            ? "毎日"
            : repeatPattern === "weekly"
            ? "毎週"
            : "毎月";
        confirmText += `**繰り返し**: ${repeatText} 🔄\n`;
      }

      // リスト名が含まれているかチェック
      const lists = await getLists(roomId);
      const matchedLists = lists.filter((list) =>
        task.includes(list.list_name)
      );

      if (matchedLists.length > 0) {
        confirmText += `\n📝 リマインド時に以下のリストも表示するよ：\n`;
        matchedLists.forEach((list) => {
          confirmText += `・**【${list.list_name}】**\n`;
        });
      }

      return [{ type: "text", text: confirmText }];
    } catch (error) {
      console.error("Database error:", error);
      return [
        {
          type: "text",
          text: "リマインダーの登録でエラーが発生しちゃった😅\nもう一度試してみて！",
        },
      ];
    }
  }

  return [
    {
      type: "text",
      text: "うーん、使い方がちょっと違うみたい😅\n「おしえてくん」だけ送ると使い方を教えるよ！",
    },
  ];
}

// ヘルプ表示
async function showHelp(): Promise<any[]> {
  const helpText = `**📚 おぼえるくん & おしえてくん 使い方ガイド**

**【おぼえるくん - リスト管理】** 📝
- \`おぼえるくん [リスト名] 追加\` → アイテムを追加
- \`おぼえるくん [リスト名]\` → リストの中身を表示
- \`おぼえるくん [リスト名] [アイテム名] 削除\` → 1つのアイテムを削除
- \`おぼえるくん [リスト名] 削除\` → リスト全体を削除
- \`おぼえるくん 一覧\` → 全リスト一覧
- \`おぼえるくん bye\` → 退室

**【おしえてくん - リマインダー】** ⏰
- \`おしえてくん [日付] [時刻] [用件]\` → リマインダー登録
- \`おしえてくん 一覧\` → リマインダー一覧
- \`おしえてくん [リマインダー名] 削除\` → リマインダー削除
- \`おしえてくん 履歴\` → 完了済みリマインダー

**📅 日付の書き方**
今日、明日、明後日、来週、3日後、12月25日、2025年12月25日

**⏰ 時刻の書き方**
朝(9時)、昼(12時)、夕方/夜(18時)、9時、15時30分、15:30

**🔄 繰り返し**
毎日、毎週、毎月 を用件に含めると繰り返しリマインダーに

**💡 便利機能**
- リマインド文にリスト名を含めると、そのリストも一緒に表示されるよ！
- 例：「おしえてくん 明日 9時 買い物に行く」→ **【買い物】**リストも表示
- リマインド通知にはスヌーズボタンが付くよ（10分/30分/1時間）

困ったときはいつでも「使い方」って送ってね😊`;

  return [{ type: "text", text: helpText }];
}
