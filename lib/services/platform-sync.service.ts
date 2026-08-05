import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

