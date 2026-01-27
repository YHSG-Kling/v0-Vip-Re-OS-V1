import { Card } from "@/components/ui/card"

interface TrendChartProps {
  title: string
  data: { label: string; value: number }[]
  color?: string
}

export function TrendChart({ title, data, color = "#4f46e5" }: TrendChartProps) {
  const maxValue = Math.max(...data.map((d) => d.value), 1)

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-slate-900 mb-6">{title}</h3>
      <div className="space-y-4">
        {data.map((item, idx) => (
          <div key={idx}>
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-slate-600">{item.label}</span>
              <span className="text-sm font-bold text-slate-900">{item.value}</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2.5">
              <div
                className="h-2.5 rounded-full transition-all duration-500"
                style={{
                  width: `${(item.value / maxValue) * 100}%`,
                  backgroundColor: color,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
