/**
 * SYSTEM 6.1 - Command Map
 * Maps voice commands to system action modules and functions
 */

export const COMMAND_MAP = {
  // CMA & Presentation System (5.3)
  generate_cma: {
    module_path: '@/app/actions/cma-presentation/cma-generator',
    function_name: 'generateCMA',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  generate_net_sheet: {
    module_path: '@/app/actions/cma-presentation/net-sheet-calculator',
    function_name: 'generateNetSheet',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  generate_presentation: {
    module_path: '@/app/actions/cma-presentation/presentation-assembler',
    function_name: 'assemblePresentation',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  // Seller Listing Lifecycle (5.2)
  schedule_appointment: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'scheduleListingAppointment',
    param_mapping: {
      listing_id: 'listingId',
      appointment_date: 'appointmentDate',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  schedule_media: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'scheduleMediaCapture',
    param_mapping: {
      listing_id: 'listingId',
      scheduled_date: 'scheduledDate',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  approve_media: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'approveMedia',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId',
      role: 'role'
    }
  },

  activate_coming_soon: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'activateComingSoon',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId',
      role: 'role'
    }
  },

  submit_to_mls: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'submitToMLSAdmin',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  activate_mls: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'activateMLS',
    param_mapping: {
      listing_id: 'listingId',
      mls_number: 'mlsNumber',
      user_id: 'userId',
      brokerage_id: 'brokerageId',
      role: 'role'
    }
  },

  schedule_open_house: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'scheduleOpenHouse',
    param_mapping: {
      listing_id: 'listingId',
      event_date: 'eventDate',
      user_id: 'userId',
      brokerage_id: 'brokerageId'
    }
  },

  approve_open_house_marketing: {
    module_path: '@/app/actions/seller-listing/execution-engine',
    function_name: 'approveOpenHouseMarketing',
    param_mapping: {
      listing_id: 'listingId',
      user_id: 'userId',
      brokerage_id: 'brokerageId',
      role: 'role'
    }
  },

  // Buyer Core Execution (5.1)
  query_buyer_stage: {
    module_path: '@/app/actions/buyer-execution',
    function_name: 'getBuyerJourney',
    param_mapping: {
      buyer_id: 'contactId',
      user_id: 'userId'
    }
  },

  configure_buyer_search: {
    module_path: '@/app/actions/buyer-execution',
    function_name: 'agentConfigureBuyerSearch',
    param_mapping: {
      buyer_id: 'contactId',
      user_id: 'agentId',
      search_preferences: 'searchPreferences'
    }
  },

  lender_confirm_financials: {
    module_path: '@/app/actions/buyer-execution',
    function_name: 'lenderConfirmBuyerFinancials',
    param_mapping: {
      buyer_id: 'contactId',
      user_id: 'lenderId',
      verification_type: 'verificationType'
    }
  },

  admin_override_financial_gate: {
    module_path: '@/app/actions/buyer-execution',
    function_name: 'adminOverrideFinancialVerification',
    param_mapping: {
      buyer_id: 'contactId',
      user_id: 'adminId',
      reason: 'reason'
    }
  },

  // Query Commands
  query_listing_status: {
    module_path: '@/app/actions/listing-lifecycle-core',
    function_name: 'getListingCurrentStage',
    param_mapping: {
      listing_id: 'listingId',
      brokerage_id: 'brokerageId'
    }
  }
} as const

export type MappedCommand = keyof typeof COMMAND_MAP
