package main

import (
	"encoding/csv"
	"strings"
)

// CsvTemplate returns a CSV template string for batch product set import.
func (a *App) CsvTemplate() ApiResult[string] {
	var b strings.Builder
	w := csv.NewWriter(&b)
	_ = w.Write([]string{"产品集"})
	_ = w.Write([]string{"示例产品集"})
	w.Flush()
	return Ok(b.String())
}
