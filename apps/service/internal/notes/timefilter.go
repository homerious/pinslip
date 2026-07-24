// timefilter.go — 便签时间范围过滤（MCP search_notes / list_notes 的
// since/until/timeField 参数落地）。Meta 的唯一来源是 store.List() 全量扫盘，
// 过滤自然发生在服务层，无需另建索引查询。
package notes

import "time"

// 时间过滤字段取值（timeField 参数）。
const (
	TimeFieldUpdated = "updated" // 默认：按更新时间
	TimeFieldCreated = "created" // 按创建时间
)

// InTimeRange 判断便签是否落在 [since, until] 闭区间（nil 端点 = 不限）。
// field 非法值按 updated 处理（入参校验在调用方，提前给中文错误）。
func InTimeRange(m Meta, field string, since, until *time.Time) bool {
	t := m.UpdatedAt
	if field == TimeFieldCreated {
		t = m.CreatedAt
	}
	if since != nil && t.Before(*since) {
		return false
	}
	if until != nil && t.After(*until) {
		return false
	}
	return true
}
