// app/api/cron/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getDueReminders,
  rescheduleRepeatingReminder,
  getListWithItems,
  getLists,
} from "@/lib/db";
import { formatDateTime } from "@/lib/dateParser";

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 現在時刻をログ出力
    const now = new Date();
    console.log(`[CRON] Checking reminders at: ${now.toISOString()} (UTC)`);
    console.log(
      `[CRON] JST: ${new Date(
        now.getTime() + 9 * 60 * 60 * 1000
      ).toISOString()}`
    );

    const dueReminders = await getDueReminders();
    console.log(`[CRON] Found ${dueReminders.length} due reminders`);

    for (const reminder of dueReminders) {
      try {
        console.log(
          `[CRON] Processing reminder ${reminder.id}: ${reminder.message}`
        );
        console.log(`[CRON] Remind at: ${reminder.remind_at} (UTC)`);

        let message = `⏰ リマインダー\n\n${reminder.message}`;

        const lists = await getLists(reminder.room_id);
        const matchedLists = [];

        for (const list of lists) {
          if (reminder.message.includes(list.list_name)) {
            const listWithItems = await getListWithItems(
              reminder.room_id,
              list.list_name
            );
            if (
              listWithItems &&
              listWithItems.items &&
              listWithItems.items.length > 0
            ) {
              matchedLists.push(listWithItems);
            }
          }
        }

        if (matchedLists.length > 0) {
          message += "\n\n📋 関連リスト\n";
          for (const list of matchedLists) {
            message += `\n【${list.list_name}】\n`;
            const items = list
              .items!.map((item) => `  ・${item.item_text}`)
              .join("\n");
            message += items + "\n";
          }
        }

        await sendReminderWithSnooze(reminder.room_id, message, reminder.id);

        // 繰り返しパターンがある場合のみ次回をスケジュール
        if (reminder.repeat_pattern) {
          await rescheduleRepeatingReminder(reminder);
        }
        console.log(
          `[CRON] Successfully sent reminder ${reminder.id} to ${reminder.room_id}`
        );
      } catch (error) {
        console.error(`[CRON] Failed to send reminder ${reminder.id}:`, error);
      }
    }

    return NextResponse.json({
      success: true,
      processed: dueReminders.length,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error("[CRON] Cron job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function sendReminderWithSnooze(
  roomId: string,
  message: string,
  reminderId: number
) {
  const pushMessage = {
    to: roomId,
    messages: [
      {
        type: "text",
        text: message,
      },
      {
        type: "template",
        altText: "スヌーズしますか?",
        template: {
          type: "buttons",
          text: "このリマインダーをスヌーズしますか?",
          actions: [
            {
              type: "postback",
              label: "⏰ 30分後",
              data: `action=snooze&reminder_id=${reminderId}&minutes=30`,
            },
            {
              type: "postback",
              label: "⏰ 1時間後",
              data: `action=snooze&reminder_id=${reminderId}&minutes=60`,
            },
            {
              type: "postback",
              label: "⏰ 3時間後",
              data: `action=snooze&reminder_id=${reminderId}&minutes=180`,
            },
            {
              type: "postback",
              label: "✅ 完了",
              data: `action=complete&reminder_id=${reminderId}`,
            },
          ],
        },
      },
    ],
  };

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(pushMessage),
  });
}
