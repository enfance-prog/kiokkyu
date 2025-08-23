import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

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
  items?: ListItem[];
}

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
): Promise<void> {
  const client = await pool.connect();
  try {
    for (const item of items) {
      await client.query(
        "INSERT INTO list_items (list_id, item_text) VALUES ($1, $2)",
        [listId, item.trim()]
      );
    }
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
  userId: string,
  listName: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "DELETE FROM lists WHERE user_id = $1 AND list_name = $2",
      [userId, listName]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}
