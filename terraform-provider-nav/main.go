package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/provider"
)

// version is set at build time with -ldflags "-X main.version=x.y.z".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/ctrl-joy/nav",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
