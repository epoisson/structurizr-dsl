/* A fixture exercising most of the grammar. */
workspace "Example" "A workspace covering the grammar" {

    !identifiers hierarchical

    properties {
        "structurizr.dsl.source" "false"
    }

    model {
        archetypes {
            application = container {
                technology "Java"
                tag "Application"
            }
            springApp = application {
                technology "Spring Boot"
            }
            sync = -> {
                tags "Synchronous"
            }
            https = --sync-> {
                technology "HTTPS"
            }
        }

        user = person "User" "A user of the system" "External"

        group "Company" {
            ss = softwareSystem "Software System" {
                description "Does things"
                url https://example.com
                tags "Tag 1,Tag 2"
                perspectives {
                    "Security" "Uses TLS" "High"
                    perspective "Cost" {
                        description "Cheap"
                        value "Low"
                    }
                }

                web = application "Web App" "Serves pages"
                api = springApp "API" {
                    group "Backend" { // components grouped
                        c1 = component "Controller" "" "Spring MVC"
                    }
                    repo = component "Repository" {
                        group "Persistence"
                        technology "JPA"
                    }
                }
                db = container "Database" "Stores data" "PostgreSQL" "Database"

                ss.web --https-> ss.api "Calls"
                ss.api -> ss.db "Reads from and writes to" "JDBC" {
                    tags "Sync"
                    properties {
                        "k" "v"
                    }
                }
            }
        }

        other = softwareSystem "Other" {
            -> ss "Depends on"
            this -> user "Notifies"
        }

        user -> ss "Uses"
        user -> ss.web "Uses"
        ext = element "Custom" "Metadata" "A custom element" "Custom"

        live = deploymentEnvironment "Live" {
            dg = deploymentGroup "Primary"
            node = deploymentNode "Server" "Prod server" "Ubuntu" "Linux" 2 {
                lb = infrastructureNode "Load balancer" "" "nginx"
                webInstance = containerInstance ss.web dg
                apiInstance = instanceOf ss.api dg {
                    healthCheck "Up" https://example.com/health 30 2000
                }
                deploymentNode "Nested" "" "Docker" {
                    containerInstance ss.db dg
                }
                node.lb -> node.webInstance "Forwards to"
            }
        }
    }

    views {
        properties {
            "plantuml.url" "https://example.com/plantuml"
        }

        systemLandscape "landscape" "Landscape" {
            include *
            autoLayout lr 300 200
            default
            title "Everything"
            animation {
                user ss
                other
            }
        }

        systemContext ss "context" {
            include *
            exclude "* -> *"
            exclude user
            autolayout
        }

        container ss "containers" "Containers" {
            include * ss.web
            exclude element.tag==Database
        }

        component ss.api "components" {
            include *
        }

        filtered "landscape" include "Element,Relationship" "filtered-landscape" "Filtered"

        dynamic ss "flow" "A flow" {
            1: user -> ss.web "Requests a page"
            ss.web -> ss.api "Calls"
            ss.api -> ss.db "Queries" "JDBC"
            autolayout lr
            title "Request flow"
        }

        deployment ss live "deployment" "Live deployment" {
            include *
        }

        custom "custom" "Custom" "A custom view" {
            include ext
        }

        image * "image" {
            plantuml diagram.puml
            title "From PlantUML"
        }

        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
                strokeWidth 2
                properties {
                    "x" "y"
                }
            }
            relationship "Relationship" {
                style dashed
                thickness 2
                routing Curved
            }
            light {
                element "Database" {
                    shape Cylinder
                }
            }
            dark {
                relationship "Sync" {
                    color #ff0000
                }
            }
        }

        theme default
        themes https://example.com/theme.json amazon-web-services-2023.01.31

        terminology {
            person "Actor"
            metadata square
        }
    }

    configuration {
        scope softwaresystem
        visibility private
        users {
            "someone@example.com" read
        }
        properties {
            "a" "b"
        }
    }
}
