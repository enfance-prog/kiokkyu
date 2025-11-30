import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  options: "-c timezone=UTC",
});

// ========== リスト関連の型定義 ==========

export interface ListItem {
  id: number;
  list_id: number;
  item_text: string;
  created_at: Date;
}

export interface List {
  id: number;
  user_id: string;
  list_name: string;
  created_at: Date;
  last_accessed_at?: Date;
  cleanup_warning_at?: Date;
  items?: ListItem[];
}

// ========== リマインダー関連の型定義 ==========

export interface Reminder {
  id: number;
  room_id: string;
  reminder_name: string;
  message: string;
  remind_at: Date;
  is_completed: boolean;
  status: string;
  repeat_pattern: string | null;
  priority: string;
  created_at: Date;
  updated_at: Date;
  cleanup_warning_at?: Date;
}

// ========== リスト関連の関数 ==========

// リスト一覧を取得
export async function getLists(userId: string): Promise<List[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM lists WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// リストを作成（存在しない場合のみ）
export async function createList(
  userId: string,
  listName: string
): Promise<List> {
  const client = await pool.connect();
  try {
    // 既に存在するかチェック
    const existing = await client.query(
      "SELECT * FROM lists WHERE user_id = $1 AND list_name = $2",
      [userId, listName]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const result = await client.query(
      "INSERT INTO lists (user_id, list_name) VALUES ($1, $2) RETURNING *",
      [userId, listName]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

// リストにアイテムを追加
export async function addItemsToList(
  listId: number,
  items: string[]
): Promise<ListItem[]> {
  const client = await pool.connect();
  try {
    const addedItems: ListItem[] = [];
    for (const item of items) {
      const result = await client.query(
        "INSERT INTO list_items (list_id, item_text) VALUES ($1, $2) RETURNING *",
        [listId, item.trim()]
      );
      addedItems.push(result.rows[0]);
    }
    // リストの最終アクセス時刻を更新
    await updateListAccessTime(listId);
    return addedItems;
  } finally {
    client.release();
  }
}

// リストとその中身を取得
export async function getListWithItems(
  userId: string,
  listName: string
): Promise<List | null> {
  const client = await pool.connect();
  try {
    const listResult = await client.query(
      "SELECT * FROM lists WHERE user_id = $1 AND list_name = $2",
      [userId, listName]
    );

    if (listResult.rows.length === 0) {
      return null;
    }

    const list = listResult.rows[0];
    const itemsResult = await client.query(
      "SELECT * FROM list_items WHERE list_id = $1 ORDER BY created_at ASC",
      [list.id]
    );

    // 最終アクセス時刻を更新
    await updateListAccessTime(list.id);

    return {
      ...list,
      items: itemsResult.rows,
    };
  } finally {
    client.release();
  }
}

// リストを削除
export async function deleteList(
  roomId: string,
  listName: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "DELETE FROM lists WHERE user_id = $1 AND list_name = $2",
      [roomId, listName]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// 特定のアイテムを削除
export async function deleteItemFromList(
  roomId: string,
  listName: string,
  itemText: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    // まずリストを取得
    const listResult = await client.query(
      "SELECT * FROM lists WHERE user_id = $1 AND list_name = $2",
      [roomId, listName]
    );

    if (listResult.rows.length === 0) {
      return false;
    }

    const list = listResult.rows[0];

    // アイテムを削除（部分一致で最初の1つだけ）
    const result = await client.query(
      "DELETE FROM list_items WHERE list_id = $1 AND item_text ILIKE $2 AND id = (SELECT id FROM list_items WHERE list_id = $1 AND item_text ILIKE $2 ORDER BY created_at ASC LIMIT 1)",
      [list.id, `%${itemText}%`]
    );

    // 最終アクセス時刻を更新
    await updateListAccessTime(list.id);

    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ========== リマインダー関連の関数 ==========

// リマインダー一覧を取得（未完了のみ）
export async function getReminders(roomId: string): Promise<Reminder[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND status != 'completed' ORDER BY remind_at ASC",
      [roomId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// リマインダーを作成
export async function createReminder(
  roomId: string,
  reminderName: string,
  message: string,
  remindAt: Date,
  repeatPattern?: string,
  priority: string = "medium"
): Promise<Reminder> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "INSERT INTO reminders (room_id, reminder_name, message, remind_at, repeat_pattern, priority, status) VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *",
      [roomId, reminderName, message, remindAt, repeatPattern || null, priority]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

// リマインダーを削除
export async function deleteReminder(
  roomId: string,
  reminderName: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "DELETE FROM reminders WHERE room_id = $1 AND reminder_name = $2",
      [roomId, reminderName]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// 特定のリマインダーを取得
export async function getReminderByName(
  roomId: string,
  reminderName: string
): Promise<Reminder | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND reminder_name = $2 AND status != 'completed'",
      [roomId, reminderName]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } finally {
    client.release();
  }
}

// リマインダーを更新
export async function updateReminder(
  roomId: string,
  reminderName: string,
  message: string,
  remindAt: Date,
  repeatPattern?: string,
  priority?: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "UPDATE reminders SET message = $3, remind_at = $4, repeat_pattern = $5, priority = $6, updated_at = CURRENT_TIMESTAMP WHERE room_id = $1 AND reminder_name = $2",
      [
        roomId,
        reminderName,
        message,
        remindAt,
        repeatPattern || null,
        priority || "medium",
      ]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// 実行予定のリマインダーを取得（定期実行用）
export async function getDueReminders(): Promise<Reminder[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM reminders WHERE status = 'active' AND remind_at <= NOW() ORDER BY remind_at ASC"
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// リマインダーを完了にする
export async function completeReminder(reminderId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE reminders SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [reminderId]
    );
  } finally {
    client.release();
  }
}

// リマインダーをスヌーズ（指定分後に再設定）
export async function snoozeReminder(
  reminderId: number,
  minutesLater: number
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE reminders SET remind_at = NOW() + INTERVAL '1 minute' * $2, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [reminderId, minutesLater]
    );
  } finally {
    client.release();
  }
}

// 繰り返しリマインダーの次回実行時刻を計算して更新
export async function rescheduleRepeatingReminder(
  reminder: Reminder
): Promise<void> {
  const client = await pool.connect();
  try {
    let nextRemindAt = new Date(reminder.remind_at);

    switch (reminder.repeat_pattern) {
      case "daily":
        nextRemindAt.setDate(nextRemindAt.getDate() + 1);
        break;
      case "weekly":
        nextRemindAt.setDate(nextRemindAt.getDate() + 7);
        break;
      case "monthly":
        nextRemindAt.setMonth(nextRemindAt.getMonth() + 1);
        break;
      default:
        // 繰り返しなしの場合は完了にする
        await completeReminder(reminder.id);
        return;
    }

    await client.query(
      "UPDATE reminders SET remind_at = $2, status = 'active' WHERE id = $1",
      [reminder.id, nextRemindAt]
    );
  } finally {
    client.release();
  }
}

// 完了したリマインダー履歴を取得
export async function getCompletedReminders(
  roomId: string,
  limit: number = 10
): Promise<Reminder[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND status = 'completed' ORDER BY updated_at DESC LIMIT $2",
      [roomId, limit]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// ========== ステータス管理関数 ==========

// リマインダーのステータスを更新
export async function updateReminderStatus(
  reminderId: number,
  status: "active" | "pending" | "completed"
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE reminders SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [reminderId, status]
    );
  } finally {
    client.release();
  }
}

// ========== カテゴリ分け取得 ==========

export interface CategorizedReminders {
  active: Reminder[];
  pending: Reminder[];
  completed: Reminder[];
}

export async function getCategorizedReminders(
  roomId: string
): Promise<CategorizedReminders> {
  const client = await pool.connect();
  try {
    const now = new Date();

    // 未完了（まだ期限が来ていない）
    const activeResult = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND status = 'active' AND remind_at > $2 ORDER BY remind_at ASC",
      [roomId, now]
    );

    // 期限超過（通知済み・アクション待ち）
    const pendingResult = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND status = 'pending' ORDER BY remind_at ASC",
      [roomId]
    );

    // 完了済み（最新10件）
    const completedResult = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND status = 'completed' ORDER BY updated_at DESC LIMIT 10",
      [roomId]
    );

    return {
      active: activeResult.rows,
      pending: pendingResult.rows,
      completed: completedResult.rows,
    };
  } finally {
    client.release();
  }
}

// ========== 複数削除 ==========

export async function deleteRemindersByIds(
  roomId: string,
  reminderIds: number[]
): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "DELETE FROM reminders WHERE room_id = $1 AND id = ANY($2::int[])",
      [roomId, reminderIds]
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}

// IDのリストからリマインダーを取得
export async function getRemindersByIds(ids: number[]): Promise<Reminder[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM reminders WHERE id = ANY($1::int[]) ORDER BY id ASC",
      [ids]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// IDのリストからリストを取得
export async function getListsByIds(ids: number[]): Promise<List[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM lists WHERE id = ANY($1::int[]) ORDER BY id ASC",
      [ids]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// ========== クリーンアップ関連 ==========

export interface StaleData {
  reminders: Reminder[];
  lists: List[];
}

// 2ヶ月以上更新がないデータを取得
export async function getStaleData(roomId: string): Promise<StaleData> {
  const client = await pool.connect();
  try {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    // 2ヶ月以上更新がなく、完了していないリマインダー
    const reminders = await client.query(
      "SELECT * FROM reminders WHERE room_id = $1 AND updated_at < $2 AND status != 'completed' AND cleanup_warning_at IS NULL",
      [roomId, twoMonthsAgo]
    );

    // 2ヶ月以上アクセスがないリスト
    const lists = await client.query(
      "SELECT * FROM lists WHERE user_id = $1 AND last_accessed_at < $2 AND cleanup_warning_at IS NULL",
      [roomId, twoMonthsAgo]
    );

    return {
      reminders: reminders.rows,
      lists: lists.rows,
    };
  } finally {
    client.release();
  }
}

// クリーンアップ警告をマーク
export async function markCleanupWarning(
  reminderIds: number[],
  listIds: number[]
): Promise<void> {
  const client = await pool.connect();
  try {
    if (reminderIds.length > 0) {
      await client.query(
        "UPDATE reminders SET cleanup_warning_at = CURRENT_TIMESTAMP WHERE id = ANY($1::int[])",
        [reminderIds]
      );
    }

    if (listIds.length > 0) {
      await client.query(
        "UPDATE lists SET cleanup_warning_at = CURRENT_TIMESTAMP WHERE id = ANY($1::int[])",
        [listIds]
      );
    }
  } finally {
    client.release();
  }
}

// 警告後1ヶ月経過したデータを削除
export async function deleteWarnedData(roomId: string): Promise<number> {
  const client = await pool.connect();
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    let totalDeleted = 0;

    // リマインダー削除
    const remindersResult = await client.query(
      "DELETE FROM reminders WHERE room_id = $1 AND cleanup_warning_at IS NOT NULL AND cleanup_warning_at < $2",
      [roomId, oneMonthAgo]
    );
    totalDeleted += remindersResult.rowCount ?? 0;

    // リスト削除
    const listsResult = await client.query(
      "DELETE FROM lists WHERE user_id = $1 AND cleanup_warning_at IS NOT NULL AND cleanup_warning_at < $2",
      [roomId, oneMonthAgo]
    );
    totalDeleted += listsResult.rowCount ?? 0;

    return totalDeleted;
  } finally {
    client.release();
  }
}

// リストの最終アクセス時刻を更新
export async function updateListAccessTime(listId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE lists SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [listId]
    );
  } finally {
    client.release();
  }
}

// 全ルームIDを取得（クリーンアップ用）
export async function getAllRoomIds(): Promise<string[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT DISTINCT room_id FROM reminders UNION SELECT DISTINCT user_id as room_id FROM lists"
    );
    return result.rows.map((row) => row.room_id);
  } finally {
    client.release();
  }
}

// クリーンアップ対象を一括削除
export async function deleteStaleDataByIds(
  reminderIds: number[],
  listIds: number[]
): Promise<{ reminders: number; lists: number }> {
  const client = await pool.connect();
  try {
    let reminderCount = 0;
    let listCount = 0;

    if (reminderIds.length > 0) {
      const reminderResult = await client.query(
        "DELETE FROM reminders WHERE id = ANY($1::int[])",
        [reminderIds]
      );
      reminderCount = reminderResult.rowCount ?? 0;
    }

    if (listIds.length > 0) {
      const listResult = await client.query(
        "DELETE FROM lists WHERE id = ANY($1::int[])",
        [listIds]
      );
      listCount = listResult.rowCount ?? 0;
    }

    return { reminders: reminderCount, lists: listCount };
  } finally {
    client.release();
  }
}
