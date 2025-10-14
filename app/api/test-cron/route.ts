// app/api/test-cron/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDueReminders } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const now = new Date();
    const reminders = await getDueReminders();

    return NextResponse.json({
      currentTime: {
        utc: now.toISOString(),
        jst: new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString(),
      },
      dueReminders: reminders.map((r) => ({
        id: r.id,
        message: r.message,
        remind_at_utc: r.remind_at,
        remind_at_jst: new Date(
          new Date(r.remind_at).getTime() + 9 * 60 * 60 * 1000
        ).toISOString(),
        is_due: new Date(r.remind_at) <= now,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
