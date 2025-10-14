// app/api/debug-reminder/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getReminders } from "@/lib/db";
import {
  parseDateTime,
  formatDateTime,
  getRelativeTime,
} from "@/lib/dateParser";

export async function GET(req: NextRequest) {
  const roomId = req.nextUrl.searchParams.get("room_id") || "test";

  try {
    // テスト用の日時パース
    const testCases = [
      { dateStr: "今日", timeStr: "9時" },
      { dateStr: "明日", timeStr: "9時" },
      { dateStr: "明日", timeStr: "18時" },
    ];

    const parsedResults = testCases.map((tc) => {
      const parsed = parseDateTime(tc.dateStr, tc.timeStr);
      return {
        input: `${tc.dateStr} ${tc.timeStr}`,
        success: parsed.success,
        date_utc: parsed.date.toISOString(),
        date_jst: new Date(
          parsed.date.getTime() + 9 * 60 * 60 * 1000
        ).toISOString(),
        formatted: formatDateTime(parsed.date),
        relative: getRelativeTime(parsed.date),
        error: parsed.error,
      };
    });

    // データベースのリマインダー取得
    const reminders = await getReminders(roomId);

    return NextResponse.json({
      currentTime: {
        utc: new Date().toISOString(),
        jst: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
      },
      parsedTests: parsedResults,
      existingReminders: reminders.map((r) => ({
        id: r.id,
        name: r.reminder_name,
        message: r.message,
        remind_at_utc: r.remind_at,
        remind_at_jst: new Date(
          new Date(r.remind_at).getTime() + 9 * 60 * 60 * 1000
        ).toISOString(),
        is_completed: r.is_completed,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
