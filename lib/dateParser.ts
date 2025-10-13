// lib/dateParser.ts
export interface ParsedDateTime {
  date: Date;
  success: boolean;
  error?: string;
}

export function parseDateTime(
  dateStr: string,
  timeStr?: string
): ParsedDateTime {
  try {
    const now = new Date();
    let targetDate = new Date(now);

    // 日付のパース
    if (dateStr === "今日" || dateStr === "きょう") {
      // 今日はそのまま
    } else if (dateStr === "明日" || dateStr === "あした") {
      targetDate.setDate(now.getDate() + 1);
    } else if (dateStr === "明後日" || dateStr === "あさって") {
      targetDate.setDate(now.getDate() + 2);
    } else if (dateStr === "来週" || dateStr === "らいしゅう") {
      targetDate.setDate(now.getDate() + 7);
    } else if (dateStr === "再来週" || dateStr === "さらいしゅう") {
      targetDate.setDate(now.getDate() + 14);
    } else if (/^(\d+)日後$/.test(dateStr)) {
      // "3日後" のような形式
      const days = parseInt(dateStr.match(/^(\d+)日後$/)![1]);
      targetDate.setDate(now.getDate() + days);
    } else if (/^(\d+)日$/.test(dateStr)) {
      // "15日" のような形式
      const day = parseInt(dateStr.match(/^(\d+)日$/)![1]);
      targetDate.setDate(day);
      // 過去の日付になる場合は来月にする
      if (targetDate < now) {
        targetDate.setMonth(targetDate.getMonth() + 1);
      }
    } else if (/^(\d+)月(\d+)日$/.test(dateStr)) {
      // "12月25日" のような形式
      const match = dateStr.match(/^(\d+)月(\d+)日$/)!;
      const month = parseInt(match[1]) - 1;
      const day = parseInt(match[2]);
      targetDate.setMonth(month);
      targetDate.setDate(day);
      // 過去の日付になる場合は来年にする
      if (targetDate < now) {
        targetDate.setFullYear(targetDate.getFullYear() + 1);
      }
    } else if (/^(\d{4})年(\d+)月(\d+)日$/.test(dateStr)) {
      // "2025年12月25日" のような形式
      const match = dateStr.match(/^(\d{4})年(\d+)月(\d+)日$/)!;
      const year = parseInt(match[1]);
      const month = parseInt(match[2]) - 1;
      const day = parseInt(match[3]);
      targetDate = new Date(year, month, day);
    } else {
      // デフォルトは今日
      targetDate = new Date(now);
    }

    // 時刻のパース
    let hour = 9; // デフォルトは朝9時
    let minute = 0;

    if (timeStr) {
      if (timeStr === "朝" || timeStr === "あさ") {
        hour = 9;
      } else if (
        timeStr === "昼" ||
        timeStr === "ひる" ||
        timeStr === "お昼" ||
        timeStr === "おひる"
      ) {
        hour = 12;
      } else if (timeStr === "午後" || timeStr === "ごご") {
        hour = 15;
      } else if (timeStr === "夕方" || timeStr === "ゆうがた") {
        hour = 18;
      } else if (timeStr === "夜" || timeStr === "よる") {
        hour = 18;
      } else if (timeStr === "深夜" || timeStr === "しんや") {
        hour = 22;
      } else if (/^(\d+)時$/.test(timeStr)) {
        // "15時" のような形式
        hour = parseInt(timeStr.match(/^(\d+)時$/)![1]);
      } else if (/^(\d+)時(\d+)分$/.test(timeStr)) {
        // "15時30分" のような形式
        const match = timeStr.match(/^(\d+)時(\d+)分$/)!;
        hour = parseInt(match[1]);
        minute = parseInt(match[2]);
      } else if (/^(\d+):(\d+)$/.test(timeStr)) {
        // "15:30" のような形式
        const match = timeStr.match(/^(\d+):(\d+)$/)!;
        hour = parseInt(match[1]);
        minute = parseInt(match[2]);
      }
    }

    targetDate.setHours(hour, minute, 0, 0);

    // 過去の日時の場合はエラー
    if (targetDate <= now) {
      return {
        date: targetDate,
        success: false,
        error: "過去の日時は設定できないよ！未来の日時を指定してね 📅",
      };
    }

    return {
      date: targetDate,
      success: true,
    };
  } catch (error) {
    return {
      date: new Date(),
      success: false,
      error:
        "日時の形式がよくわからなかった😅\n例：「明日 9時」「12月25日 15時30分」「3日後 昼」",
    };
  }
}

// 繰り返しパターンのパース
export function parseRepeatPattern(text: string): string | null {
  if (text.includes("毎日") || text.includes("まいにち")) {
    return "daily";
  } else if (text.includes("毎週") || text.includes("まいしゅう")) {
    return "weekly";
  } else if (text.includes("毎月") || text.includes("まいつき")) {
    return "monthly";
  }
  return null;
}

// 日時を人間が読みやすい形式にフォーマット
export function formatDateTime(date: Date): string {
  const now = new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();

  // 今年の場合は年を省略
  const yearStr = year === now.getFullYear() ? "" : `${year}年`;
  const minuteStr = minute === 0 ? "" : `${minute}分`;

  return `${yearStr}${month}月${day}日 ${hour}時${minuteStr}`.trim();
}

// 相対時間表現（〇〇分後、〇時間後など）
export function getRelativeTime(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}日後`;
  } else if (hours > 0) {
    return `${hours}時間後`;
  } else if (minutes > 0) {
    return `${minutes}分後`;
  } else {
    return "今すぐ";
  }
}
