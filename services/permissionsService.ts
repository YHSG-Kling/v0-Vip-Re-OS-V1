// Compatibility shim — logic has moved to lib/security/permissions-service
import { permissionsService } from '@/lib/security/permissions-service'

export {
  permissionsService,
  ROLE_NAVIGATION,
} from '@/lib/security/permissions-service'
export type {
  Permission,
  UserAccessContext,
  UserSubType,
} from '@/lib/security/permissions-service'
export default permissionsService
