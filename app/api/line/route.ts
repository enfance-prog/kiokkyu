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

    // Postbackイベント処理（ボタン操作）
    if (event.type === "postback") {
      const replyToken = event.replyToken;
      const data = new URLSearchParams(event.postback.data);
      const action = data.get("action");
      const roomId =
        event.source.groupId || event.source.roomId || event.source.userId;

      let replyMessages: any[] = [];

      // スヌーズ・完了処理
      if (action === "snooze") {
        const reminderId = parseInt(data.get("reminder_id") || "0");
        const minutes = parseInt(data.get("minutes") || "10");
        try {
          await snoozeReminder(reminderId, minutes);
          replyMessages = [
            { type: "text", text: `⏰ ${minutes}分後にまたリマインドするね！` },
          ];
        } catch (error) {
          console.error("Snooze error:", error);
          replyMessages = [
            { type: "text", text: "スヌーズの設定でエラーが発生しちゃった😅" },
          ];
        }
      } else if (action === "complete") {
        const reminderId = parseInt(data.get("reminder_id") || "0");
        try {
          await completeReminder(reminderId);
          replyMessages = [
            {
              type: "text",
              text: "✅ リマインダーを完了にしたよ！お疲れさま 🎉",
            },
          ];
        } catch (error) {
          console.error("Complete error:", error);
          replyMessages = [
            { type: "text", text: "完了処理でエラーが発生しちゃった😅" },
          ];
        }
      }
      // リスト表示
      else if (action === "show_list") {
        const listName = data.get("list_name") || "";
        replyMessages = await showListDetails(roomId, listName);
      }
      // リスト追加
      else if (action === "add_to_list") {
        const listName = data.get("list_name") || "";
        roomStates.set(roomId, { waitingFor: "items", listName });
        replyMessages = [
          {
            type: "text",
            text: `【${listName}】に追加したいものを教えてね～📝\n改行で区切って複数のアイテムを一度に追加できるよ！\n\n例：\nネギ\nキャベツ\nひき肉`,
          },
        ];
      }
      // リスト削除
      else if (action === "delete_list") {
        const listName = data.get("list_name") || "";
        try {
          const deleted = await deleteList(roomId, listName);
          if (deleted) {
            replyMessages = [
              {
                type: "text",
                text: `【${listName}】を完全に削除したよ🗑️\nまた新しいリストが必要になったらいつでも作ってね！`,
              },
            ];
          } else {
            replyMessages = [
              {
                type: "text",
                text: `あれ？【${listName}】が見つからなかった🤔`,
              },
            ];
          }
        } catch (error) {
          replyMessages = [
            { type: "text", text: "削除でエラーが発生しちゃった😅" },
          ];
        }
      }
      // リマインダー表示
      else if (action === "show_reminder") {
        const reminderName = data.get("reminder_name") || "";
        replyMessages = await showReminderDetails(roomId, reminderName);
      }
      // リマインダー削除
      else if (action === "delete_reminder") {
        const reminderName = data.get("reminder_name") || "";
        try {
          const deleted = await deleteReminder(roomId, reminderName);
          if (deleted) {
            replyMessages = [
              {
                type: "text",
                text: `【${reminderName}】のリマインダーを削除したよ🗑️`,
              },
            ];
          } else {
            replyMessages = [
              {
                type: "text",
                text: `【${reminderName}】のリマインダーが見つからなかった🤔`,
              },
            ];
          }
        } catch (error) {
          replyMessages = [
            { type: "text", text: "削除でエラーが発生しちゃった😅" },
          ];
        }
      }

      if (replyMessages.length > 0) {
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
          .map((item) => `  ・${item.item_text}`)
          .join("\n");
        return [
          {
            type: "text",
            text: `やったね！【${roomState.listName}】に追加完了だよ✨\n\n＜追加されたアイテム＞\n${itemList}\n\n「おぼえるくん ${roomState.listName}」で全部の中身も確認できるよ！`,
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
        text: "さようなら～👋 また呼んでくれたら嬉しいな！\nおぼえるくんはいつでも君のリスト管理を待ってるよ✨",
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

      // リスト一覧をボタン付きで表示
      let text = "━━━━━━━━━━━━━━\n";
      text += "📋 登録中のリスト一覧\n";
      text += "━━━━━━━━━━━━━━\n\n";
      text += "下のボタンから確認したいリストを選んでね！\n\n";
      lists.forEach((list, index) => {
        text += `${index + 1}. ${list.list_name}\n`;
      });

      const quickReply = {
        items: lists.slice(0, 13).map((list) => ({
          type: "action",
          action: {
            type: "postback",
            label: list.list_name,
            data: `action=show_list&list_name=${encodeURIComponent(
              list.list_name
            )}`,
            displayText: `おぼえるくん ${list.list_name}`,
          },
        })),
      };

      return [
        {
          type: "text",
          text: text,
          quickReply: quickReply,
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
    return await showListDetails(roomId, listName);
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
            .map((item) => `  ・${item.item_text}`)
            .join("\n");
          return [
            {
              type: "text",
              text: `よし！「${itemName}」を削除したよ🗑️\n\n【${listName}】の最新の中身\n${itemList}`,
            },
          ];
        } else {
          return [
            {
              type: "text",
              text: `「${itemName}」を削除したら、【${listName}】が空になっちゃった😅\n新しいアイテムを追加するなら「おぼえるくん ${listName} 追加」だよ！`,
            },
          ];
        }
      } else {
        return [
          {
            type: "text",
            text: `あれ？「${itemName}」が【${listName}】に見つからなかった🤔\n「おぼえるくん ${listName}」で中身を確認してみて！`,
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
            text: `【${listName}】に追加したいものを教えてね～📝\n改行で区切って複数のアイテムを一度に追加できるよ！\n\n例：\nネギ\nキャベツ\nひき肉`,
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
              text: `【${listName}】を完全に削除したよ🗑️\nまた新しいリストが必要になったらいつでも作ってね！`,
            },
          ];
        } else {
          return [
            {
              type: "text",
              text: `あれ？【${listName}】が見つからなかった🤔\n「おぼえるくん 一覧」で確認してみて！`,
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
      text: "うーん、ちょっとよくわからなかった😅\n「おぼえるくん」だけ送ると使い方を詳しく教えるよ～📚",
    },
  ];
}

// リスト詳細表示（ボタン付き）
async function showListDetails(
  roomId: string,
  listName: string
): Promise<any[]> {
  try {
    const list = await getListWithItems(roomId, listName);
    if (!list || !list.items || list.items.length === 0) {
      return [
        {
          type: "text",
          text: `【${listName}】はまだ空っぽだよ～📝\n「おぼえるくん ${listName} 追加」でアイテムを入れてみよう！`,
        },
      ];
    }

    let text = "━━━━━━━━━━━━━━\n";
    text += `📝 【${listName}】の中身\n`;
    text += "━━━━━━━━━━━━━━\n\n";

    list.items.forEach((item, index) => {
      text += `  ${index + 1}. ${item.item_text}\n`;
    });

    text += "\n次のアクションを選んでね！";

    const quickReply = {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "➕ 追加",
            data: `action=add_to_list&list_name=${encodeURIComponent(
              listName
            )}`,
            displayText: `おぼえるくん ${listName} 追加`,
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "🗑️ リスト削除",
            data: `action=delete_list&list_name=${encodeURIComponent(
              listName
            )}`,
            displayText: `おぼえるくん ${listName} 削除`,
          },
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "📋 一覧に戻る",
            text: "おぼえるくん 一覧",
          },
        },
      ],
    };

    return [
      {
        type: "text",
        text: text,
        quickReply: quickReply,
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

      let text = "━━━━━━━━━━━━━━\n";
      text += "⏰ 登録中のリマインダー\n";
      text += "━━━━━━━━━━━━━━\n\n";
      text += "下のボタンから確認したいリマインダーを選んでね！\n\n";

      reminders.forEach((reminder, index) => {
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
        text += `${index + 1}. ${priority} ${reminder.reminder_name}\n`;
        text += `   ${formatDateTime(
          new Date(reminder.remind_at)
        )} (${getRelativeTime(new Date(reminder.remind_at))}) ${repeat}\n\n`;
      });

      const quickReply = {
        items: reminders.slice(0, 13).map((reminder) => ({
          type: "action",
          action: {
            type: "postback",
            label: reminder.reminder_name.substring(0, 20),
            data: `action=show_reminder&reminder_name=${encodeURIComponent(
              reminder.reminder_name
            )}`,
            displayText: `おしえてくん ${reminder.reminder_name}`,
          },
        })),
      };

      return [
        {
          type: "text",
          text: text,
          quickReply: quickReply,
        },
      ];
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

      let text = "━━━━━━━━━━━━━━\n";
      text += "📜 完了したリマインダー履歴\n";
      text += "━━━━━━━━━━━━━━\n\n";

      completed.forEach((reminder, index) => {
        text += `${index + 1}. ✅ ${reminder.reminder_name}\n`;
        text += `   完了: ${formatDateTime(new Date(reminder.updated_at))}\n\n`;
      });

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
            text: `【${reminderName}】のリマインダーを削除したよ🗑️`,
          },
        ];
      } else {
        return [
          {
            type: "text",
            text: `【${reminderName}】のリマインダーが見つからなかった🤔\n「おしえてくん 一覧」で確認してみて！`,
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

      let confirmText = "━━━━━━━━━━━━━━\n";
      confirmText += "⏰ リマインダーを設定したよ！\n";
      confirmText += "━━━━━━━━━━━━━━\n\n";
      confirmText += `＜いつ＞\n  ${formatDateTime(
        parsed.date
      )} (${getRelativeTime(parsed.date)})\n\n`;
      confirmText += `＜用件＞\n  ${task}\n\n`;

      if (repeatPattern) {
        const repeatText =
          repeatPattern === "daily"
            ? "毎日"
            : repeatPattern === "weekly"
            ? "毎週"
            : "毎月";
        confirmText += `＜繰り返し＞\n  ${repeatText} 🔄\n\n`;
      }

      // リスト名が含まれているかチェック
      const lists = await getLists(roomId);
      const matchedLists = lists.filter((list) =>
        task.includes(list.list_name)
      );

      if (matchedLists.length > 0) {
        confirmText += `📝 リマインド時に以下のリストも表示するよ：\n`;
        matchedLists.forEach((list) => {
          confirmText += `  ・【${list.list_name}】\n`;
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

// リマインダー詳細表示（ボタン付き）
async function showReminderDetails(
  roomId: string,
  reminderName: string
): Promise<any[]> {
  try {
    const reminder = await getReminderByName(roomId, reminderName);
    if (!reminder) {
      return [
        {
          type: "text",
          text: `【${reminderName}】のリマインダーが見つからなかった🤔`,
        },
      ];
    }

    const priority =
      reminder.priority === "high"
        ? "🔴高"
        : reminder.priority === "low"
        ? "🟢低"
        : "🟡中";
    const repeat =
      reminder.repeat_pattern === "daily"
        ? "🔄毎日"
        : reminder.repeat_pattern === "weekly"
        ? "🔄毎週"
        : reminder.repeat_pattern === "monthly"
        ? "🔄毎月"
        : "なし";

    let text = "━━━━━━━━━━━━━━\n";
    text += `⏰ リマインダー詳細\n`;
    text += "━━━━━━━━━━━━━━\n\n";
    text += `＜用件＞\n  ${reminder.message}\n\n`;
    text += `＜日時＞\n  ${formatDateTime(
      new Date(reminder.remind_at)
    )}\n  (${getRelativeTime(new Date(reminder.remind_at))})\n\n`;
    text += `＜優先度＞\n  ${priority}\n\n`;
    text += `＜繰り返し＞\n  ${repeat}\n\n`;
    text += "次のアクションを選んでね！";

    const quickReply = {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "🗑️ 削除",
            data: `action=delete_reminder&reminder_name=${encodeURIComponent(
              reminderName
            )}`,
            displayText: `おしえてくん ${reminderName} 削除`,
          },
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "📋 一覧に戻る",
            text: "おしえてくん 一覧",
          },
        },
      ],
    };

    return [
      {
        type: "text",
        text: text,
        quickReply: quickReply,
      },
    ];
  } catch (error) {
    console.error("Database error:", error);
    return [
      { type: "text", text: "リマインダーの取得でエラーが発生しちゃった😅" },
    ];
  }
}

// ヘルプ表示
async function showHelp(): Promise<any[]> {
  const helpText = `━━━━━━━━━━━━━━
📚 おぼえるくん & おしえてくん
   使い方ガイド
━━━━━━━━━━━━━━

【おぼえるくん - リスト管理】📝

＜基本操作＞
  ・おぼえるくん [リスト名] 追加
    → アイテムを追加
  ・おぼえるくん [リスト名]
    → リストの中身を表示
  ・おぼえるくん [リスト名] [アイテム名] 削除
    → 1つのアイテムを削除
  ・おぼえるくん [リスト名] 削除
    → リスト全体を削除
  ・おぼえるくん 一覧
    → 全リスト一覧（ボタンで選択可能）
  ・おぼえるくん bye
    → 退室

━━━━━━━━━━━━━━

【おしえてくん - リマインダー】⏰

＜基本操作＞
  ・おしえてくん [日付] [時刻] [用件]
    → リマインダー登録
  ・おしえてくん 一覧
    → リマインダー一覧（ボタンで選択可能）
  ・おしえてくん [リマインダー名] 削除
    → リマインダー削除
  ・おしえてくん 履歴
    → 完了済みリマインダー

＜日付の書き方＞
  今日、明日、明後日、来週、3日後
  12月25日、2025年12月25日

＜時刻の書き方＞
  朝(9時)、昼(12時)、夕方/夜(18時)
  9時、15時30分、15:30

＜繰り返し＞
  毎日、毎週、毎月
  → 用件に含めると繰り返しリマインダーに

━━━━━━━━━━━━━━

💡 便利機能

  ・リマインド文にリスト名を含めると
    そのリストも一緒に表示されるよ！
    
    例：「おしえてくん 明日 9時 買い物に行く」
    → 【買い物】リストも表示
    
  ・リマインド通知にはスヌーズボタンが
    付くよ（10分/30分/1時間）
    
  ・一覧表示後はボタンで簡単操作！

━━━━━━━━━━━━━━

困ったときはいつでも
「使い方」って送ってね😊`;

  return [{ type: "text", text: helpText }];
}
