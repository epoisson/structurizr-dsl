// A workspace split across files. Try:
//   structurizr-dsl check   examples/multi-file/main.dsl
//   structurizr-dsl svg     examples/multi-file/main.dsl --view landscape -o landscape.svg
//   structurizr-dsl summary examples/multi-file/main.dsl --define ENV=prod

!const COMPANY "Acme"
!var   ENV     "dev"

workspace "${COMPANY} online shop (${ENV})" "Constants, variables and includes in one place" {

    model {
        // a file, relative to this one
        !include people/users.dsl

        // a directory: every .dsl file in it, in name order
        !include systems

        customer -> shop "Browses and orders"
        shop -> payments "Takes payment"
        support  -> shop "Refunds orders"
    }

    views {
        systemLandscape "landscape" "Everything" {
            include *
            autoLayout lr
        }
    }
}
