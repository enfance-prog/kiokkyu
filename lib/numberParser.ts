// lib/numberParser.ts

/**
 * ユーザー入力から番号を柔軟に解析
 * 対応形式: "1 3", "1, 3", "1. 3.", "1\n3" など
 */
export function parseNumbers(input: string): number[] {
  // 1. 改行、カンマ、スペース、ピリオドを統一的な区切りとして扱う
  const cleaned = input
    .replace(/[,.\n\s]+/g, " ") // 区切り文字をすべてスペースに統一
    .trim();

  // 2. スペースで分割して数字のみを抽出
  const numbers = cleaned
    .split(" ")
    .map((str) => {
      // 数字以外を除去
      const num = str.replace(/[^0-9]/g, "");
      return parseInt(num);
    })
    .filter((num) => !isNaN(num) && num > 0); // 有効な数字のみ

  // 3. 重複を除去してソート
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * テスト用の例
 */
export function testNumberParser() {
  const testCases = [
    "1 3", // => [1, 3]
    "1, 3", // => [1, 3]
    "1. 3.", // => [1, 3]
    "1\n3", // => [1, 3]
    "1,3,5", // => [1, 3, 5]
    "1. 2. 3.", // => [1, 2, 3]
    "1 2 3 2 1", // => [1, 2, 3] (重複除去)
    " 1  ,  3  ", // => [1, 3] (スペース無視)
  ];

  testCases.forEach((input) => {
    console.log(
      `Input: "${input}" => Output: ${JSON.stringify(parseNumbers(input))}`
    );
  });
}
