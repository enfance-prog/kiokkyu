// app/api/cleanup-check/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getAllRoomIds,
  getStaleData,
  markCleanupWarning,
  deleteWarnedData,
} from "@/lib/db";

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[CLEANUP] Starting cleanup check...");

    // 1. まず、警告後1ヶ月経過したデータを自動削除
    await deleteExpiredWarnings();

    // 2. 次に、新たなクリーンアップ対象をチェックして通知
    await checkAndNotifyStaleData();

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CLEANUP] Cleanup check error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// 警告後1ヶ月経過したデータを削除
async function deleteExpiredWarnings() {
  console.log("[CLEANUP] Checking for expired warnings...");

  try {
    const roomIds = await getAllRoomIds();

    for (const roomId of roomIds) {
      try {
        const deletedCount = await deleteWarnedData(roomId);
        if (deletedCount > 0) {
          console.log(
            `[CLEANUP] Auto-deleted ${deletedCount} items for room ${roomId}`
          );

          // 削除完了通知
          await sendDeletionNotification(roomId, deletedCount);
        }
      } catch (error) {
        console.error(
          `[CLEANUP] Error deleting warned data for room ${roomId}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("[CLEANUP] Error in deleteExpiredWarnings:", error);
  }
}

// 放置データをチェックして通知
async function checkAndNotifyStaleData() {
  console.log("[CLEANUP] Checking for stale data...");

  try {
    const roomIds = await getAllRoomIds();

    for (const roomId of roomIds) {
      try {
        const staleData = await getStaleData(roomId);

        if (staleData.reminders.length > 0 || staleData.lists.length > 0) {
          console.log(
            `[CLEANUP] Found stale data for room ${roomId}: ${staleData.reminders.length} reminders, ${staleData.lists.length} lists`
          );

          await sendCleanupNotification(
            roomId,
            staleData.reminders.length,
            staleData.lists.length,
            staleData.reminders.map((r) => r.id),
            staleData.lists.map((l) => l.id)
          );
        }
      } catch (error) {
        console.error(
          `[CLEANUP] Error checking stale data for room ${roomId}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("[CLEANUP] Error in checkAndNotifyStaleData:", error);
  }
}

// クリーンアップ通知を送信
async function sendCleanupNotification(
  roomId: string,
  reminderCount: number,
  listCount: number,
  reminderIds: number[],
  listIds: number[]
) {
  const message = {
    to: roomId,
    messages: [
      {
        type: "text",
        text: `🧹 データのクリーンアップ\n\n2ヶ月以上使われていないデータが見つかりました：\n\n【リマインダー】${reminderCount}件\n【リスト】${listCount}件\n\n削除してデータベースを整理しますか？`,
      },
      {
        type: "template",
        altText: "クリーンアップを実行しますか？",
        template: {
          type: "buttons",
          text: "次のアクションを選んでください",
          actions: [
            {
              type: "postback",
              label: "🗑️ すべて削除",
              data: `action=cleanup_all&reminder_ids=${reminderIds.join(
                ","
              )}&list_ids=${listIds.join(",")}`,
            },
            {
              type: "postback",
              label: "📝 選んで削除",
              data: `action=cleanup_select&reminder_ids=${reminderIds.join(
                ","
              )}&list_ids=${listIds.join(",")}`,
            },
            {
              type: "postback",
              label: "⏰ 1ヶ月保留",
              data: `action=cleanup_postpone&reminder_ids=${reminderIds.join(
                ","
              )}&list_ids=${listIds.join(",")}`,
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
    body: JSON.stringify(message),
  });
}

// 自動削除完了通知
async function sendDeletionNotification(roomId: string, count: number) {
  const message = {
    to: roomId,
    messages: [
      {
        type: "text",
        text: `🗑️ 自動クリーンアップ完了\n\n1ヶ月間使われなかったデータを${count}件削除しました。\n\nデータベースがスッキリしたよ✨`,
      },
    ],
  };

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(message),
  });
}
