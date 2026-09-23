export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      action_logs: {
        Row: {
          action: string
          canteen_id: string | null
          created_at: string
          details: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          canteen_id?: string | null
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          canteen_id?: string | null
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "action_logs_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          key_hash: string
          label: string
          revoked: boolean
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash: string
          label: string
          revoked?: boolean
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash?: string
          label?: string
          revoked?: boolean
        }
        Relationships: []
      }
      attendance: {
        Row: {
          canteen_id: string
          check_in: string | null
          check_out: string | null
          date: string
          id: string
          staff_id: string
          status: string
        }
        Insert: {
          canteen_id: string
          check_in?: string | null
          check_out?: string | null
          date?: string
          id?: string
          staff_id: string
          status?: string
        }
        Update: {
          canteen_id?: string
          check_in?: string | null
          check_out?: string | null
          date?: string
          id?: string
          staff_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      canteens: {
        Row: {
          address: string | null
          created_at: string
          email: string | null
          gst_number: string | null
          id: string
          location: string | null
          name: string
          phone: string | null
          staff_count: number | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          email?: string | null
          gst_number?: string | null
          id?: string
          location?: string | null
          name: string
          phone?: string | null
          staff_count?: number | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          email?: string | null
          gst_number?: string | null
          id?: string
          location?: string | null
          name?: string
          phone?: string | null
          staff_count?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      corporate_accounts: {
        Row: {
          billing_notes: string | null
          canteen_id: string
          code: string | null
          contact_email: string | null
          contact_person: string | null
          contact_phone: string | null
          created_at: string
          gstin: string | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          billing_notes?: string | null
          canteen_id: string
          code?: string | null
          contact_email?: string | null
          contact_person?: string | null
          contact_phone?: string | null
          created_at?: string
          gstin?: string | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          billing_notes?: string | null
          canteen_id?: string
          code?: string | null
          contact_email?: string | null
          contact_person?: string | null
          contact_phone?: string | null
          created_at?: string
          gstin?: string | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_accounts_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_invoices: {
        Row: {
          canteen_id: string
          corporate_account_id: string
          generated_at: string
          generated_by: string | null
          id: string
          order_count: number
          paid_at: string | null
          period_end: string
          period_start: string
          status: string
          total_amount: number
        }
        Insert: {
          canteen_id: string
          corporate_account_id: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          order_count?: number
          paid_at?: string | null
          period_end: string
          period_start: string
          status?: string
          total_amount?: number
        }
        Update: {
          canteen_id?: string
          corporate_account_id?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          order_count?: number
          paid_at?: string | null
          period_end?: string
          period_start?: string
          status?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "corporate_invoices_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_invoices_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_meal_rates: {
        Row: {
          corporate_account_id: string
          created_at: string
          id: string
          is_active: boolean
          meal_type: string
          rate: number
          recipe_id: string | null
        }
        Insert: {
          corporate_account_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          meal_type: string
          rate: number
          recipe_id?: string | null
        }
        Update: {
          corporate_account_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          meal_type?: string
          rate?: number
          recipe_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_meal_rates_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_meal_rates_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          canteen_id: string
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          expense_date: string
          id: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          canteen_id: string
          category: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expense_date?: string
          id?: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          canteen_id?: string
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expense_date?: string
          id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_alerts: {
        Row: {
          actual_value: number | null
          alert_type: string
          canteen_id: string
          created_at: string
          description: string
          expected_value: number | null
          id: string
          ingredient_id: string | null
          loss_value: number | null
          purchase_id: string | null
          severity: string
          status: string
          title: string
        }
        Insert: {
          actual_value?: number | null
          alert_type: string
          canteen_id: string
          created_at?: string
          description: string
          expected_value?: number | null
          id?: string
          ingredient_id?: string | null
          loss_value?: number | null
          purchase_id?: string | null
          severity?: string
          status?: string
          title: string
        }
        Update: {
          actual_value?: number | null
          alert_type?: string
          canteen_id?: string
          created_at?: string
          description?: string
          expected_value?: number | null
          id?: string
          ingredient_id?: string | null
          loss_value?: number | null
          purchase_id?: string | null
          severity?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_alerts_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_alerts_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "fraud_alerts_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_alerts_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredient_batches: {
        Row: {
          batch_no: string | null
          canteen_id: string
          created_at: string
          expiry_date: string | null
          id: string
          ingredient_id: string
          purchase_id: string | null
          qty_received: number
          qty_remaining: number
          rate: number
          received_at: string
          supplier_id: string | null
        }
        Insert: {
          batch_no?: string | null
          canteen_id: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          ingredient_id: string
          purchase_id?: string | null
          qty_received: number
          qty_remaining: number
          rate?: number
          received_at?: string
          supplier_id?: string | null
        }
        Update: {
          batch_no?: string | null
          canteen_id?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          ingredient_id?: string
          purchase_id?: string | null
          qty_received?: number
          qty_remaining?: number
          rate?: number
          received_at?: string
          supplier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_batches_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_batches_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "ingredient_batches_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_batches_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_batches_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredient_usage_log: {
        Row: {
          canteen_id: string
          created_at: string
          id: string
          ingredient_id: string | null
          menu_item_id: string | null
          order_id: string | null
          quantity_used: number
          unit: string
        }
        Insert: {
          canteen_id: string
          created_at?: string
          id?: string
          ingredient_id?: string | null
          menu_item_id?: string | null
          order_id?: string | null
          quantity_used: number
          unit: string
        }
        Update: {
          canteen_id?: string
          created_at?: string
          id?: string
          ingredient_id?: string | null
          menu_item_id?: string | null
          order_id?: string | null
          quantity_used?: number
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_usage_log_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_usage_log_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "ingredient_usage_log_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_usage_log_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_usage_log_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredients: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          avg_daily_usage: number | null
          canteen_id: string
          category: string
          carbohydrate_g: number | null
          cost_per_unit: number | null
          created_at: string
          current_stock: number
          energy_kcal: number | null
          fat_g: number | null
          fibre_g: number | null
          id: string
          maximum_stock: number | null
          minimum_stock: number
          name: string
          nutrition_basis_qty: number
          nutrition_basis_unit: string
          nutrition_source: string | null
          nutrition_updated_at: string | null
          nutrition_updated_by: string | null
          protein_g: number | null
          reorder_level: number | null
          shelf_life_days: number | null
          unit: string
          updated_at: string
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          avg_daily_usage?: number | null
          canteen_id: string
          category?: string
          carbohydrate_g?: number | null
          cost_per_unit?: number | null
          created_at?: string
          current_stock?: number
          energy_kcal?: number | null
          fat_g?: number | null
          fibre_g?: number | null
          id?: string
          maximum_stock?: number | null
          minimum_stock?: number
          name: string
          nutrition_basis_qty?: number
          nutrition_basis_unit?: string
          nutrition_source?: string | null
          nutrition_updated_at?: string | null
          nutrition_updated_by?: string | null
          protein_g?: number | null
          reorder_level?: number | null
          shelf_life_days?: number | null
          unit?: string
          updated_at?: string
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          avg_daily_usage?: number | null
          canteen_id?: string
          category?: string
          carbohydrate_g?: number | null
          cost_per_unit?: number | null
          created_at?: string
          current_stock?: number
          energy_kcal?: number | null
          fat_g?: number | null
          fibre_g?: number | null
          id?: string
          maximum_stock?: number | null
          minimum_stock?: number
          name?: string
          nutrition_basis_qty?: number
          nutrition_basis_unit?: string
          nutrition_source?: string | null
          nutrition_updated_at?: string | null
          nutrition_updated_by?: string | null
          protein_g?: number | null
          reorder_level?: number | null
          shelf_life_days?: number | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingredients_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      kitchen_returns: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          canteen_id: string
          created_at: string
          id: string
          ingredient_id: string
          qty: number
          reason: string | null
          requisition_id: string | null
          returned_by: string | null
          status: string
          unit: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          canteen_id: string
          created_at?: string
          id?: string
          ingredient_id: string
          qty: number
          reason?: string | null
          requisition_id?: string | null
          returned_by?: string | null
          status?: string
          unit?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          canteen_id?: string
          created_at?: string
          id?: string
          ingredient_id?: string
          qty?: number
          reason?: string | null
          requisition_id?: string | null
          returned_by?: string | null
          status?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kitchen_returns_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kitchen_returns_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "kitchen_returns_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kitchen_returns_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_entries: {
        Row: {
          amount: number | null
          canteen_id: string
          corporate_account_id: string
          corporate_invoice_id: string | null
          created_at: string
          created_by: string | null
          entry_date: string
          id: string
          meal_type: string
          notes: string | null
          plates: number
          rate: number
        }
        Insert: {
          amount?: number | null
          canteen_id: string
          corporate_account_id: string
          corporate_invoice_id?: string | null
          created_at?: string
          created_by?: string | null
          entry_date: string
          id?: string
          meal_type: string
          notes?: string | null
          plates: number
          rate: number
        }
        Update: {
          amount?: number | null
          canteen_id?: string
          corporate_account_id?: string
          corporate_invoice_id?: string | null
          created_at?: string
          created_by?: string | null
          entry_date?: string
          id?: string
          meal_type?: string
          notes?: string | null
          plates?: number
          rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "meal_entries_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_entries_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_entries_corporate_invoice_id_fkey"
            columns: ["corporate_invoice_id"]
            isOneToOne: false
            referencedRelation: "corporate_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_plan: {
        Row: {
          canteen_id: string
          created_at: string
          id: string
          meal_type: string
          recipe_id: string | null
          weekday: number
        }
        Insert: {
          canteen_id: string
          created_at?: string
          id?: string
          meal_type: string
          recipe_id?: string | null
          weekday: number
        }
        Update: {
          canteen_id?: string
          created_at?: string
          id?: string
          meal_type?: string
          recipe_id?: string | null
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "meal_plan_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_plan_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_rates: {
        Row: {
          canteen_id: string
          created_at: string
          id: string
          meal_period: string
          rate: number
          updated_at: string
        }
        Insert: {
          canteen_id: string
          created_at?: string
          id?: string
          meal_period: string
          rate: number
          updated_at?: string
        }
        Update: {
          canteen_id?: string
          created_at?: string
          id?: string
          meal_period?: string
          rate?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_rates_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          available: boolean | null
          canteen_id: string
          category: string
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          is_available: boolean | null
          name: string
          price: number
          recipe_id: string | null
          updated_at: string | null
        }
        Insert: {
          available?: boolean | null
          canteen_id: string
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_available?: boolean | null
          name: string
          price?: number
          recipe_id?: string | null
          updated_at?: string | null
        }
        Update: {
          available?: boolean | null
          canteen_id?: string
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_available?: boolean | null
          name?: string
          price?: number
          recipe_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_plan_items: {
        Row: {
          created_at: string
          dish_name: string
          id: string
          menu_plan_id: string
          planned_qty: number | null
          produced_at: string | null
          produced_qty: number | null
          recipe_id: string | null
          unit: string | null
          wastage_qty: number | null
        }
        Insert: {
          created_at?: string
          dish_name: string
          id?: string
          menu_plan_id: string
          planned_qty?: number | null
          produced_at?: string | null
          produced_qty?: number | null
          recipe_id?: string | null
          unit?: string | null
          wastage_qty?: number | null
        }
        Update: {
          created_at?: string
          dish_name?: string
          id?: string
          menu_plan_id?: string
          planned_qty?: number | null
          produced_at?: string | null
          produced_qty?: number | null
          recipe_id?: string | null
          unit?: string | null
          wastage_qty?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_plan_items_menu_plan_id_fkey"
            columns: ["menu_plan_id"]
            isOneToOne: false
            referencedRelation: "menu_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_plan_items_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_plans: {
        Row: {
          actual_headcount: number | null
          canteen_id: string
          created_at: string
          created_by: string | null
          expected_headcount: number
          id: string
          meal_period: string
          menu_date: string
          notes: string | null
          published_at: string | null
          status: string
        }
        Insert: {
          actual_headcount?: number | null
          canteen_id: string
          created_at?: string
          created_by?: string | null
          expected_headcount?: number
          id?: string
          meal_period: string
          menu_date: string
          notes?: string | null
          published_at?: string | null
          status?: string
        }
        Update: {
          actual_headcount?: number | null
          canteen_id?: string
          created_at?: string
          created_by?: string | null
          expected_headcount?: number
          id?: string
          meal_period?: string
          menu_date?: string
          notes?: string | null
          published_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_plans_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          canteen_id: string | null
          created_at: string
          id: string
          link: string | null
          read_at: string | null
          ref_id: string | null
          ref_type: string | null
          target_role: string | null
          target_user: string | null
          title: string
        }
        Insert: {
          body?: string | null
          canteen_id?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          ref_id?: string | null
          ref_type?: string | null
          target_role?: string | null
          target_user?: string | null
          title: string
        }
        Update: {
          body?: string | null
          canteen_id?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          ref_id?: string | null
          ref_type?: string | null
          target_role?: string | null
          target_user?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          item_name: string | null
          item_price: number | null
          menu_item_id: string | null
          name: string | null
          order_id: string
          price: number
          quantity: number
          total: number
          total_price: number | null
          unit_price: number | null
        }
        Insert: {
          id?: string
          item_name?: string | null
          item_price?: number | null
          menu_item_id?: string | null
          name?: string | null
          order_id: string
          price?: number
          quantity?: number
          total?: number
          total_price?: number | null
          unit_price?: number | null
        }
        Update: {
          id?: string
          item_name?: string | null
          item_price?: number | null
          menu_item_id?: string | null
          name?: string | null
          order_id?: string
          price?: number
          quantity?: number
          total?: number
          total_price?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          canteen_id: string
          corporate_account_id: string | null
          corporate_invoice_id: string | null
          created_at: string
          customer_name: string | null
          discount: number | null
          employee_code: string | null
          id: string
          kitchen_status: string
          kot_number: string | null
          order_items: Json | null
          order_number: string | null
          order_type: string
          payment_mode: string | null
          payment_status: string
          preparing_at: string | null
          ready_at: string | null
          served_at: string | null
          special_instructions: string | null
          status: string | null
          table_number: string | null
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          canteen_id: string
          corporate_account_id?: string | null
          corporate_invoice_id?: string | null
          created_at?: string
          customer_name?: string | null
          discount?: number | null
          employee_code?: string | null
          id?: string
          kitchen_status?: string
          kot_number?: string | null
          order_items?: Json | null
          order_number?: string | null
          order_type?: string
          payment_mode?: string | null
          payment_status?: string
          preparing_at?: string | null
          ready_at?: string | null
          served_at?: string | null
          special_instructions?: string | null
          status?: string | null
          table_number?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Update: {
          canteen_id?: string
          corporate_account_id?: string | null
          corporate_invoice_id?: string | null
          created_at?: string
          customer_name?: string | null
          discount?: number | null
          employee_code?: string | null
          id?: string
          kitchen_status?: string
          kot_number?: string | null
          order_items?: Json | null
          order_number?: string | null
          order_type?: string
          payment_mode?: string | null
          payment_status?: string
          preparing_at?: string | null
          ready_at?: string | null
          served_at?: string | null
          special_instructions?: string | null
          status?: string | null
          table_number?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_corporate_invoice_id_fkey"
            columns: ["corporate_invoice_id"]
            isOneToOne: false
            referencedRelation: "corporate_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_items: {
        Row: {
          confidence_score: number | null
          id: string
          ingredient_id: string | null
          item_name: string
          matched: boolean | null
          purchase_id: string
          quantity: number
          rate: number
          total: number
          unit: string
        }
        Insert: {
          confidence_score?: number | null
          id?: string
          ingredient_id?: string | null
          item_name: string
          matched?: boolean | null
          purchase_id: string
          quantity: number
          rate?: number
          total?: number
          unit?: string
        }
        Update: {
          confidence_score?: number | null
          id?: string
          ingredient_id?: string | null
          item_name?: string
          matched?: boolean | null
          purchase_id?: string
          quantity?: number
          rate?: number
          total?: number
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "purchase_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          id: string
          ingredient_id: string | null
          item_name: string
          po_id: string
          quantity: number
          rate: number
          total: number | null
          unit: string | null
        }
        Insert: {
          id?: string
          ingredient_id?: string | null
          item_name: string
          po_id: string
          quantity: number
          rate?: number
          total?: number | null
          unit?: string | null
        }
        Update: {
          id?: string
          ingredient_id?: string | null
          item_name?: string
          po_id?: string
          quantity?: number
          rate?: number
          total?: number | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "purchase_order_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          canteen_id: string
          created_at: string
          created_by: string | null
          expected_date: string | null
          id: string
          notes: string | null
          po_date: string
          po_no: number
          purchase_id: string | null
          status: string
          supplier_id: string | null
          total_amount: number
        }
        Insert: {
          canteen_id: string
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          po_date?: string
          po_no?: never
          purchase_id?: string | null
          status?: string
          supplier_id?: string | null
          total_amount?: number
        }
        Update: {
          canteen_id?: string
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          po_date?: string
          po_no?: never
          purchase_id?: string | null
          status?: string
          supplier_id?: string | null
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      purchases: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          canteen_id: string
          created_at: string
          created_by: string | null
          id: string
          invoice_image_url: string | null
          notes: string | null
          paid_at: string | null
          payment_ref: string | null
          payment_status: string
          status: string
          supplier_id: string | null
          total_amount: number | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          canteen_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_image_url?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_ref?: string | null
          payment_status?: string
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          canteen_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_image_url?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_ref?: string | null
          payment_status?: string
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchases_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_directory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_ingredients: {
        Row: {
          id: string
          ingredient_id: string | null
          quantity: number
          recipe_id: string
          sub_recipe_id: string | null
          unit: string
        }
        Insert: {
          id?: string
          ingredient_id?: string | null
          quantity: number
          recipe_id: string
          sub_recipe_id?: string | null
          unit: string
        }
        Update: {
          id?: string
          ingredient_id?: string | null
          quantity?: number
          recipe_id?: string
          sub_recipe_id?: string | null
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "recipe_ingredients_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_ingredients_sub_recipe_id_fkey"
            columns: ["sub_recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          canteen_id: string
          category: string | null
          created_at: string
          id: string
          instructions: string | null
          is_semi_finished: boolean | null
          name: string
          updated_at: string | null
          yield_qty: number | null
          yield_unit: string | null
        }
        Insert: {
          canteen_id: string
          category?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_semi_finished?: boolean | null
          name: string
          updated_at?: string | null
          yield_qty?: number | null
          yield_unit?: string | null
        }
        Update: {
          canteen_id?: string
          category?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_semi_finished?: boolean | null
          name?: string
          updated_at?: string | null
          yield_qty?: number | null
          yield_unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipes_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      requisition_items: {
        Row: {
          amount: number | null
          approved_qty: number | null
          created_at: string
          head_chef_qty: number | null
          id: string
          ingredient_id: string
          issued_qty: number | null
          issued_value: number | null
          rate: number | null
          requested_qty: number
          requisition_id: string
          unit: string | null
        }
        Insert: {
          amount?: number | null
          approved_qty?: number | null
          created_at?: string
          head_chef_qty?: number | null
          id?: string
          ingredient_id: string
          issued_qty?: number | null
          issued_value?: number | null
          rate?: number | null
          requested_qty: number
          requisition_id: string
          unit?: string | null
        }
        Update: {
          amount?: number | null
          approved_qty?: number | null
          created_at?: string
          head_chef_qty?: number | null
          id?: string
          ingredient_id?: string
          issued_qty?: number | null
          issued_value?: number | null
          rate?: number | null
          requested_qty?: number
          requisition_id?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "requisition_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "requisition_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requisition_items_requisition_id_fkey"
            columns: ["requisition_id"]
            isOneToOne: false
            referencedRelation: "requisitions"
            referencedColumns: ["id"]
          },
        ]
      }
      requisitions: {
        Row: {
          canteen_id: string
          created_at: string
          expected_headcount: number | null
          head_chef_notes: string | null
          head_chef_required: boolean
          head_chef_reviewed_at: string | null
          head_chef_reviewed_by: string | null
          head_chef_status: string
          id: string
          issued_at: string | null
          issued_by: string | null
          meal_period: string | null
          menu_plan_id: string | null
          notes: string | null
          req_date: string
          req_no: number
          requested_by: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
        }
        Insert: {
          canteen_id: string
          created_at?: string
          expected_headcount?: number | null
          head_chef_notes?: string | null
          head_chef_required?: boolean
          head_chef_reviewed_at?: string | null
          head_chef_reviewed_by?: string | null
          head_chef_status?: string
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          meal_period?: string | null
          menu_plan_id?: string | null
          notes?: string | null
          req_date?: string
          req_no?: never
          requested_by?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          canteen_id?: string
          created_at?: string
          expected_headcount?: number | null
          head_chef_notes?: string | null
          head_chef_required?: boolean
          head_chef_reviewed_at?: string | null
          head_chef_reviewed_by?: string | null
          head_chef_status?: string
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          meal_period?: string | null
          menu_plan_id?: string | null
          notes?: string | null
          req_date?: string
          req_no?: never
          requested_by?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "requisitions_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requisitions_menu_plan_id_fkey"
            columns: ["menu_plan_id"]
            isOneToOne: false
            referencedRelation: "menu_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      site_budgets: {
        Row: {
          budget_month: string
          canteen_id: string
          created_at: string
          created_by: string | null
          food_budget: number
          food_cost_pct: number | null
          id: string
          labour_budget: number
          notes: string | null
          purchase_budget: number
        }
        Insert: {
          budget_month: string
          canteen_id: string
          created_at?: string
          created_by?: string | null
          food_budget?: number
          food_cost_pct?: number | null
          id?: string
          labour_budget?: number
          notes?: string | null
          purchase_budget?: number
        }
        Update: {
          budget_month?: string
          canteen_id?: string
          created_at?: string
          created_by?: string | null
          food_budget?: number
          food_cost_pct?: number | null
          id?: string
          labour_budget?: number
          notes?: string | null
          purchase_budget?: number
        }
        Relationships: [
          {
            foreignKeyName: "site_budgets_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          active: boolean | null
          canteen_id: string
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          role: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          active?: boolean | null
          canteen_id: string
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          role?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          active?: boolean | null
          canteen_id?: string
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          role?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_ledger: {
        Row: {
          balance_after: number
          canteen_id: string
          change_qty: number
          created_at: string
          created_by: string | null
          id: string
          ingredient_id: string
          reason: string
          reference_id: string | null
          reference_type: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          service_date: string | null
          value: number | null
        }
        Insert: {
          balance_after: number
          canteen_id: string
          change_qty: number
          created_at?: string
          created_by?: string | null
          id?: string
          ingredient_id: string
          reason: string
          reference_id?: string | null
          reference_type?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          service_date?: string | null
          value?: number | null
        }
        Update: {
          balance_after?: number
          canteen_id?: string
          change_qty?: number
          created_at?: string
          created_by?: string | null
          id?: string
          ingredient_id?: string
          reason?: string
          reference_id?: string | null
          reference_type?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          service_date?: string | null
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_ledger_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_ledger_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "stock_ledger_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_photos: {
        Row: {
          canteen_id: string
          captured_at: string | null
          created_at: string
          created_by: string | null
          expires_at: string | null
          geo_accuracy: number | null
          id: string
          image_path: string
          latitude: number | null
          longitude: number | null
          media_kind: string
          note: string | null
          photo_type: string
          reference_id: string | null
        }
        Insert: {
          canteen_id: string
          captured_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          geo_accuracy?: number | null
          id?: string
          image_path: string
          latitude?: number | null
          longitude?: number | null
          media_kind?: string
          note?: string | null
          photo_type: string
          reference_id?: string | null
        }
        Update: {
          canteen_id?: string
          captured_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          geo_accuracy?: number | null
          id?: string
          image_path?: string
          latitude?: number | null
          longitude?: number | null
          media_kind?: string
          note?: string | null
          photo_type?: string
          reference_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_photos_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          canteen_id: string | null
          contact_person: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          address?: string | null
          canteen_id?: string | null
          contact_person?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          address?: string | null
          canteen_id?: string | null
          contact_person?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          canteen_id: string | null
          created_at: string
          full_name: string | null
          id: string
          role: string
          supplier_id: string | null
          user_id: string
        }
        Insert: {
          canteen_id?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          role: string
          supplier_id?: string | null
          user_id: string
        }
        Update: {
          canteen_id?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          role?: string
          supplier_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "user_directory"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sites: {
        Row: {
          canteen_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          canteen_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          canteen_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_sites_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_bill_items: {
        Row: {
          created_at: string
          id: string
          ingredient_id: string | null
          item_name: string
          quantity: number
          rate: number
          total: number
          unit: string | null
          vendor_bill_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          ingredient_id?: string | null
          item_name: string
          quantity?: number
          rate?: number
          total?: number
          unit?: string | null
          vendor_bill_id: string
        }
        Update: {
          created_at?: string
          id?: string
          ingredient_id?: string | null
          item_name?: string
          quantity?: number
          rate?: number
          total?: number
          unit?: string | null
          vendor_bill_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_bill_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredient_rates"
            referencedColumns: ["ingredient_id"]
          },
          {
            foreignKeyName: "vendor_bill_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bill_items_vendor_bill_id_fkey"
            columns: ["vendor_bill_id"]
            isOneToOne: false
            referencedRelation: "vendor_bills"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_bills: {
        Row: {
          bill_date: string | null
          bill_no: string | null
          canteen_id: string
          captured_at: string | null
          created_at: string
          geo_accuracy: number | null
          gstin: string | null
          id: string
          image_path: string | null
          latitude: number | null
          longitude: number | null
          notes: string | null
          purchase_id: string | null
          review_notes: string | null
          status: string
          submitted_by: string | null
          supplier_id: string
          total_value: number
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          bill_date?: string | null
          bill_no?: string | null
          canteen_id: string
          captured_at?: string | null
          created_at?: string
          geo_accuracy?: number | null
          gstin?: string | null
          id?: string
          image_path?: string | null
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          purchase_id?: string | null
          review_notes?: string | null
          status?: string
          submitted_by?: string | null
          supplier_id: string
          total_value?: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          bill_date?: string | null
          bill_no?: string | null
          canteen_id?: string
          captured_at?: string | null
          created_at?: string
          geo_accuracy?: number | null
          gstin?: string | null
          id?: string
          image_path?: string | null
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          purchase_id?: string | null
          review_notes?: string | null
          status?: string
          submitted_by?: string | null
          supplier_id?: string
          total_value?: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_bills_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ingredient_rates: {
        Row: {
          canteen_id: string | null
          category: string | null
          current_stock: number | null
          ingredient_id: string | null
          latest_rate: number | null
          lots: Json | null
          name: string | null
          rate_from: string | null
          rate_from_invoice: boolean | null
          stock_rate: number | null
          stock_value: number | null
          unit: string | null
          unlotted_qty: number | null
          unlotted_rate: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ingredients_canteen_id_fkey"
            columns: ["canteen_id"]
            isOneToOne: false
            referencedRelation: "canteens"
            referencedColumns: ["id"]
          },
        ]
      }
      user_directory: {
        Row: {
          email: string | null
          id: string | null
        }
        Insert: {
          email?: string | null
          id?: string | null
        }
        Update: {
          email?: string | null
          id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_return: {
        Args: { p_accept?: boolean; p_return_id: string }
        Returns: Json
      }
      add_stock_from_invoice: {
        Args: {
          p_canteen_id: string
          p_image_path?: string
          p_items: Json
          p_notes?: string
          p_supplier_id: string
          p_total?: number
        }
        Returns: Json
      }
      adjust_stock: {
        Args: { p_ingredient_id: string; p_new_stock: number; p_reason: string }
        Returns: Json
      }
      allow_stock_move: { Args: never; Returns: undefined }
      budget_vs_actual: {
        Args: { p_canteen_id: string; p_month: string }
        Returns: Json
      }
      can_access_canteen: { Args: { cid: string }; Returns: boolean }
      can_issue_stock: { Args: never; Returns: boolean }
      can_raise_requisition: { Args: never; Returns: boolean }
      can_receive_stock: { Args: never; Returns: boolean }
      computed_sale: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: number
      }
      confirm_purchase: { Args: { p_purchase_id: string }; Returns: Json }
      consume_batches_fifo: {
        Args: { p_canteen_id: string; p_ingredient_id: string; p_qty: number }
        Returns: number
      }
      consumption_report: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: {
          label: string
          qty: number
          scope: string
          unit: string
          value: number
        }[]
      }
      convert_vendor_bill: { Args: { p_bill_id: string }; Returns: Json }
      daily_reconciliation: {
        Args: { p_canteen_id: string; p_date: string }
        Returns: Json
      }
      daitch_mokotoff: { Args: { "": string }; Returns: string[] }
      day_kitchen_plan: {
        Args: { p_canteen_id: string; p_date: string }
        Returns: Json
      }
      dmetaphone: { Args: { "": string }; Returns: string }
      dmetaphone_alt: { Args: { "": string }; Returns: string }
      fifo_cost_preview: {
        Args: { p_ingredient_id: string; p_qty: number }
        Returns: number
      }
      generate_corporate_invoice: {
        Args: {
          p_account_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: Json
      }
      generate_corporate_invoice_from_meals: {
        Args: {
          p_account_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: Json
      }
      get_my_canteen: { Args: never; Returns: string }
      get_my_role: { Args: never; Returns: string }
      get_qr_order: { Args: { p_order_id: string }; Returns: Json }
      is_admin_editor: { Args: never; Returns: boolean }
      is_chef: { Args: never; Returns: boolean }
      is_head_chef: { Args: never; Returns: boolean }
      is_manager_or_above: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      is_store_keeper: { Args: never; Returns: boolean }
      is_store_keeper_or_above: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      is_vendor: { Args: never; Returns: boolean }
      issue_requisition: { Args: { p_req_id: string }; Returns: Json }
      manager_dashboard: {
        Args: { p_canteen_id: string; p_date: string }
        Returns: Json
      }
      meal_cost_report: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: {
          avg_headcount: number
          headcount: number
          meal_period: string
          meals: number
          wastage_qty: number
        }[]
      }
      meal_profit_analysis: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: Json
      }
      merge_ingredients: {
        Args: { p_from: string; p_into: string }
        Returns: Json
      }
      my_rank: { Args: never; Returns: number }
      my_supplier_id: { Args: never; Returns: string }
      operations_summary: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: Json
      }
      period_summary: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: Json
      }
      place_qr_order: {
        Args: {
          p_canteen_id: string
          p_customer_name?: string
          p_instructions?: string
          p_items: Json
        }
        Returns: Json
      }
      purchase_report: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: {
          amount: number
          label: string
          qty: number
          scope: string
          txn_count: number
        }[]
      }
      purge_expired_stock_photos: { Args: never; Returns: number }
      quantity_in_nutrition_base: {
        Args: { p_qty: number; p_unit: string }
        Returns: number
      }
      record_stock_issue: {
        Args: { p_canteen_id: string; p_items: Json }
        Returns: Json
      }
      require_issue_photo: {
        Args: { p_canteen_id: string; p_req_id: string }
        Returns: boolean
      }
      return_to_store: {
        Args: { p_items: Json; p_reason?: string; p_requisition_id: string }
        Returns: Json
      }
      returnable_items: {
        Args: { p_requisition_id: string }
        Returns: {
          already_returned: number
          can_return: number
          ingredient_id: string
          issued: number
          name: string
          unit: string
        }[]
      }
      role_rank: { Args: { p_role: string }; Returns: number }
      run_photo_purge: { Args: never; Returns: number }
      save_dish_recipe: {
        Args: {
          p_canteen_id: string
          p_dish_name: string
          p_items: Json
          p_yield_qty?: number
          p_yield_unit?: string
        }
        Returns: Json
      }
      set_ingredient_nutrition: {
        Args: {
          p_basis_qty: number
          p_basis_unit: string
          p_carbohydrate_g: number | null
          p_energy_kcal: number | null
          p_fat_g: number | null
          p_fibre_g: number | null
          p_ingredient_id: string
          p_protein_g: number | null
          p_source?: string | null
        }
        Returns: Database["public"]["Tables"]["ingredients"]["Row"]
      }
      similar_ingredients: {
        Args: { p_canteen_id: string }
        Returns: {
          a_id: string
          a_name: string
          a_stock: number
          b_id: string
          b_name: string
          b_stock: number
          distance: number
        }[]
      }
      site_performance: {
        Args: { p_end: string; p_start: string }
        Returns: {
          canteen_id: string
          consumption: number
          cost_per_person: number
          food_cost_pct: number
          headcount: number
          inventory_value: number
          open_alerts: number
          purchase: number
          revenue: number
          site_name: string
        }[]
      }
      soundex: { Args: { "": string }; Returns: string }
      stock_ageing: {
        Args: { p_canteen_id: string }
        Returns: {
          current_stock: number
          days_of_stock: number
          days_since_movement: number
          ingredient_id: string
          last_issue_at: string
          movement_class: string
          name: string
          oldest_batch_at: string
          stock_value: number
          unit: string
        }[]
      }
      stock_in_out_report: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: {
          adjustments: number
          closing: number
          closing_value: number
          in_value: number
          ingredient_id: string
          name: string
          opening: number
          out_value: number
          rate: number
          stock_in: number
          stock_out: number
          unit: string
        }[]
      }
      stock_variance_report: {
        Args: { p_canteen_id: string; p_end: string; p_start: string }
        Returns: {
          audit_adjust: number
          audit_loss_value: number
          consumed_qty: number
          cost_per_unit: number
          current_stock: number
          ingredient_id: string
          manual_adjust: number
          name: string
          purchased_qty: number
          unit: string
        }[]
      }
      store_keeper_dashboard: {
        Args: { p_canteen_id: string; p_date: string }
        Returns: Json
      }
      submit_stock_audit: {
        Args: { p_canteen_id: string; p_entries: Json }
        Returns: Json
      }
      suggest_requisition: {
        Args: { p_canteen_id: string; p_days?: number; p_headcount: number }
        Returns: {
          category: string
          current_stock: number
          days_of_history: number
          est_value: number
          ingredient_id: string
          latest_rate: number
          name: string
          per_head: number
          rate_from_invoice: boolean
          shortfall: number
          suggested_qty: number
          unit: string
        }[]
      }
      text_soundex: { Args: { "": string }; Returns: string }
      transfer_stock: {
        Args: {
          p_from_canteen: string
          p_items: Json
          p_note?: string
          p_to_canteen: string
        }
        Returns: Json
      }
      uncounted_meals: {
        Args: { p_canteen_id: string; p_days?: number }
        Returns: {
          expected_headcount: number
          id: string
          issued: boolean
          meal_period: string
          menu_date: string
        }[]
      }
      vendor_stock_report: {
        Args: { p_canteen_id: string }
        Returns: {
          items: number
          oldest_batch: string
          qty_remaining: number
          supplier_id: string
          value_remaining: number
          vendor: string
        }[]
      }
      weekly_budget_utilisation: {
        Args: { p_canteen_id: string; p_month: string }
        Returns: {
          budget: number
          consumption: number
          headcount: number
          purchase: number
          running_consumption: number
          used_pct: number
          week_end: string
          week_start: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
