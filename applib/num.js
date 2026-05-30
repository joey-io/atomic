// Parse a grid cell as a number for numeric sort, else null (text sort instead).
export function num(s) {
  return /^-?[\d,]+(\.\d+)?$/.test(s) ? parseFloat(s.replace(/,/g, '')) : null;
}
