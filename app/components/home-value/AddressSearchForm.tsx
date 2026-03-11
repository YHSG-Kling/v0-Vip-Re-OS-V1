"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { submitHomeValueRequest } from "@/app/actions/home-value"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ArrowRight, ArrowLeft, Loader2, Home, User, Shield } from "lucide-react"

interface AddressSearchFormProps {
  agentSlug?: string
  brokerageId?: string
  utmSource?: string
}

type FormStep = 1 | 2

export function AddressSearchForm({
  agentSlug,
  brokerageId,
  utmSource,
}: AddressSearchFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [step, setStep] = useState<FormStep>(1)
  const [error, setError] = useState<string | null>(null)

  // Step 1: Property Details
  const [propertyAddress, setPropertyAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zipCode, setZipCode] = useState("")
  const [bedrooms, setBedrooms] = useState("")
  const [bathrooms, setBathrooms] = useState("")
  const [squareFeet, setSquareFeet] = useState("")
  const [yearBuilt, setYearBuilt] = useState("")
  const [condition, setCondition] = useState("")

  // Step 2: Contact Info
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")

  const isStep1Valid =
    propertyAddress.trim() !== "" &&
    city.trim() !== "" &&
    state.trim() !== "" &&
    zipCode.trim() !== "" &&
    bedrooms !== "" &&
    bathrooms !== "" &&
    squareFeet.trim() !== "" &&
    yearBuilt.trim() !== "" &&
    condition !== ""

  const isStep2Valid =
    firstName.trim() !== "" &&
    lastName.trim() !== "" &&
    email.trim() !== "" &&
    phone.trim() !== ""

  function handleNext() {
    if (isStep1Valid) {
      setStep(2)
    }
  }

  function handleBack() {
    setStep(1)
  }

  async function handleSubmit() {
    if (!isStep2Valid) return

    setError(null)

    startTransition(async () => {
      const result = await submitHomeValueRequest({
        propertyAddress,
        city,
        state,
        zipCode,
        bedrooms: parseInt(bedrooms, 10),
        bathrooms: parseFloat(bathrooms),
        squareFeet: parseInt(squareFeet, 10),
        yearBuilt: parseInt(yearBuilt, 10),
        condition,
        firstName,
        lastName,
        email,
        phone,
        agentSlug,
        brokerageId,
        utmSource,
      })

      if (result.success && result.requestId) {
        router.push(`/home-value/${result.requestId}`)
      } else {
        setError(result.error || "Something went wrong. Please try again.")
      }
    })
  }

  return (
    <Card className="shadow-lg">
      <CardHeader className="text-center">
        <div className="flex justify-center mb-4">
          <div className="flex items-center gap-2">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                step === 1
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              1
            </div>
            <div className="h-0.5 w-8 bg-muted" />
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                step === 2
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              2
            </div>
          </div>
        </div>
        <CardTitle className="flex items-center justify-center gap-2">
          {step === 1 ? (
            <>
              <Home className="h-5 w-5" />
              Property Details
            </>
          ) : (
            <>
              <User className="h-5 w-5" />
              Your Information
            </>
          )}
        </CardTitle>
        <CardDescription>
          {step === 1
            ? "Tell us about your property"
            : "We'll email your full report"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {step === 1 && (
          <>
            {/* Address */}
            <div className="space-y-2">
              <Label htmlFor="address">Street Address</Label>
              <Input
                id="address"
                placeholder="123 Main Street"
                value={propertyAddress}
                onChange={(e) => setPropertyAddress(e.target.value)}
              />
            </div>

            {/* City, State, Zip */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  placeholder="City"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  placeholder="TX"
                  maxLength={2}
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP Code</Label>
                <Input
                  id="zip"
                  placeholder="75001"
                  maxLength={5}
                  value={zipCode}
                  onChange={(e) => setZipCode(e.target.value)}
                />
              </div>
            </div>

            {/* Beds and Baths */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bedrooms">Bedrooms</Label>
                <Select value={bedrooms} onValueChange={setBedrooms}>
                  <SelectTrigger id="bedrooms">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 8 ? "8+" : n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bathrooms">Bathrooms</Label>
                <Select value={bathrooms} onValueChange={setBathrooms}>
                  <SelectTrigger id="bathrooms">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 7 ? "7+" : n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Sqft and Year Built */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sqft">Square Feet</Label>
                <Input
                  id="sqft"
                  type="number"
                  placeholder="2,000"
                  value={squareFeet}
                  onChange={(e) => setSquareFeet(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="year">Year Built</Label>
                <Input
                  id="year"
                  type="number"
                  placeholder="1995"
                  value={yearBuilt}
                  onChange={(e) => setYearBuilt(e.target.value)}
                />
              </div>
            </div>

            {/* Condition */}
            <div className="space-y-2">
              <Label htmlFor="condition">Condition</Label>
              <Select value={condition} onValueChange={setCondition}>
                <SelectTrigger id="condition">
                  <SelectValue placeholder="Select condition" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent</SelectItem>
                  <SelectItem value="good">Good</SelectItem>
                  <SelectItem value="fair">Fair</SelectItem>
                  <SelectItem value="poor">Poor</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              className="w-full mt-4"
              size="lg"
              onClick={handleNext}
              disabled={!isStep1Valid}
            >
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            {/* First Name */}
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                placeholder="John"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>

            {/* Last Name */}
            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                placeholder="Smith"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="john@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {/* Phone */}
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            {/* Privacy Notice */}
            <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
              <Shield className="h-4 w-4 mt-0.5 shrink-0" />
              <p>We never sell your information. Your data is used only to provide your estimate and connect you with a local expert.</p>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <div className="flex gap-3 mt-4">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={isPending}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <Button
                className="flex-1"
                size="lg"
                onClick={handleSubmit}
                disabled={!isStep2Valid || isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Estimate...
                  </>
                ) : (
                  <>
                    Get My Free Estimate
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
