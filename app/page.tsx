export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto text-center">
        <h1 className="text-4xl font-bold mb-8">おぼえるくん</h1>
        <p className="text-lg text-gray-600 mb-8">
          リスト管理ができるLINE BOTです
        </p>
        <div className="bg-gray-100 rounded-lg p-6 text-left">
          <h2 className="text-xl font-semibold mb-4">使い方</h2>
          <ul className="space-y-2">
            <li>
              <code>おぼえるくん</code> - ヘルプを表示
            </li>
            <li>
              <code>おぼえるくん [リスト名] 追加</code> - アイテムを追加
            </li>
            <li>
              <code>おぼえるくん [リスト名]</code> - リストの中身を表示
            </li>
            <li>
              <code>おぼえるくん [リスト名] 削除</code> - リストを削除
            </li>
            <li>
              <code>おぼえるくん [リスト名] [アイテム名] 削除</code> -
              1つのアイテムを削除
            </li>
            <li>
              <code>おぼえるくん 一覧</code> - リスト一覧を表示
            </li>
            <li>
              <code>おぼえるくん bye</code> - BOTを退出
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
