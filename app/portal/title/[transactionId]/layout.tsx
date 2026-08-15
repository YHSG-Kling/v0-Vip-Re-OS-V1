import React from "react"

interface Props {
  children: React.ReactNode
  params: Promise<{ transactionId: string }>
}

export default function TitleTransactionLayout({ children }: Props) {
  return <>{children}</>
}
