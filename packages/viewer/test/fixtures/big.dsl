workspace "Stress" "A busier landscape" {
    model {
        customer = person "Customer" "Buys things online"
        support = person "Support Agent" "Helps customers"
        shop = softwareSystem "Online Shop" "Storefront and ordering"
        crm = softwareSystem "CRM" "Customer records" "Internal"
        payments = softwareSystem "Payment Provider" "Card processing" "External"
        mail = softwareSystem "Email Service" "Sends email" "External"
        stock = softwareSystem "Inventory" "Stock levels" "Internal"
        ship = softwareSystem "Shipping Partner" "Delivers parcels" "External"
        bi = softwareSystem "Analytics" "Reporting" "Internal"
        customer -> shop "Browses and orders"
        customer -> shop "Tracks parcels"
        shop -> customer "Sends receipts"
        support -> crm "Looks up customers"
        support -> shop "Refunds orders"
        shop -> payments "Takes payment"
        payments -> shop "Confirms payment"
        shop -> stock "Reserves stock"
        stock -> ship "Requests pickup"
        shop -> mail "Sends notifications"
        mail -> customer "Delivers email"
        shop -> crm "Syncs customers"
        crm -> bi "Exports data"
        shop -> bi "Streams events"
        stock -> bi "Exports levels"
        ship -> customer "Delivers parcels"
        stock -> stock "Rebalances"
    }
    views {
        systemLandscape "landscape" "Everything" {
            include *
        }
        styles {
            element "External" {
                background #999999
            }
            element "Internal" {
                background #1168bd
            }
        }
    }
}
